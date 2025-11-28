#!/usr/bin/env node

import { mkdirSync, readFileSync } from 'fs'
import { Level } from 'level'
import { createTx } from '../../tx/transactionFactory.ts'

import { createBlockFromBytesArray } from '../../block/index.ts'
import { CliqueConsensus, createBlockchain } from '../../blockchain/index.ts'
import { ConsensusAlgorithm, Hardfork } from '../../chain-config/index.ts'
import * as RLP from '../../rlp/index.ts'
import { bytesToHex, createAddressFromString, EthereumJSErrorWithoutCode, short } from '../../utils/index.ts'

import { EthereumClient } from '../client.ts'
import { Config, DataDirectory } from '../config.ts'
import { LevelDB } from '../execution/level.ts'
import { getEnvArgs } from './envArgs.ts'
import { helpRPC, startRPCServers } from './startRPC.ts'
import { generateClientConfig } from './utils.ts'

import type { AbstractLevel } from 'abstract-level'
import type * as http from 'http'
import type { Server as RPCServer } from 'jayson/promise/index.js'
import type { Block, BlockBytes } from '../../block/index.ts'
import type { ConsensusDict } from '../../blockchain/index.ts'
import type { GenesisState } from '../../chain-config/index.ts'
import type { Logger } from '../logging.ts'
import type { FullEthereumService } from '../service/fullethereumservice.ts'
import type { ClientOpts } from '../types.ts'
import type { RPCArgs } from './startRPC.ts'

let logger: Logger | undefined

// Read all configuration from ENV instead of CLI args
const args: ClientOpts = getEnvArgs()

/**
 * Initializes and returns the databases needed for the client
 */
function initDBs(config: Config): {
  chainDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
  stateDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
  metaDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
} {
  // Chain DB
  const chainDataDir = config.getDataDirectory(DataDirectory.Chain)
  mkdirSync(chainDataDir, {
    recursive: true,
  })
  const chainDB = new Level<string | Uint8Array, string | Uint8Array>(
    chainDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  // State DB
  const stateDataDir = config.getDataDirectory(DataDirectory.State)
  mkdirSync(stateDataDir, {
    recursive: true,
  })
  const stateDB = new Level<string | Uint8Array, string | Uint8Array>(
    stateDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  // Meta DB (receipts, logs, indexes, skeleton chain)
  const metaDataDir = config.getDataDirectory(DataDirectory.Meta)
  mkdirSync(metaDataDir, {
    recursive: true,
  })
  const metaDB = new Level<string | Uint8Array, string | Uint8Array>(
    metaDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  return { chainDB, stateDB, metaDB }
}

/**
 * Special block execution debug mode (does not change any state)
 */
async function executeBlocks(client: EthereumClient) {
  let first = 0
  let last = 0
  let txHashes = []
  try {
    const blockRange = (args.executeBlocks as string).split('-').map((val) => {
      const reNum = /([0-9]+)/.exec(val)
      const num = reNum ? parseInt(reNum[1]) : 0
      const reTxs = /[0-9]+\[(.*)\]/.exec(val)
      const txs = reTxs ? reTxs[1].split(',') : []
      return [num, txs]
    })
    first = blockRange[0][0] as number
    last = blockRange.length === 2 ? (blockRange[1][0] as number) : first
    txHashes = blockRange[0][1] as string[]

    if ((blockRange[0][1] as string[]).length > 0 && blockRange.length === 2) {
      throw EthereumJSErrorWithoutCode('wrong input')
    }
  } catch {
    throw EthereumJSErrorWithoutCode(
      'Wrong input format for block execution, allowed format types: 5, 5-10, 5[0xba4b5fd92a26badad3cad22eb6f7c7e745053739b5f5d1e8a3afb00f8fb2a280,[TX_HASH_2],...], 5[*] (all txs in verbose mode)',
    )
  }
  const { execution } = client.service
  if (execution === undefined) throw EthereumJSErrorWithoutCode('executeBlocks requires execution')
  await execution.executeBlocks(first, last, txHashes)
}

/**
 * Starts the client on a specified block number.
 * Note: this is destructive and removes blocks from the blockchain. Please back up your datadir.
 */
async function startBlock(client: EthereumClient) {
  if (args.startBlock === undefined) return
  const startBlock = BigInt(args.startBlock)
  const height = client.chain.headers.height
  if (height < startBlock) {
    throw EthereumJSErrorWithoutCode(`Cannot start chain higher than current height ${height}`)
  }
  try {
    await client.chain.resetCanonicalHead(startBlock)
    client.config.logger?.info(`Chain height reset to ${client.chain.headers.height}`)
  } catch (err: any) {
    throw EthereumJSErrorWithoutCode(`Error setting back chain in startBlock: ${err}`)
  }
}

/**
 * Periodically broadcasts simple value-transfer transactions from the first unlocked account.
 *
 * Controlled by ENV:
 *   ETH_TX_INTERVAL_MS - interval between txs in ms (e.g. 10000 = 10s). If unset or invalid, disabled.
 *   ETH_TX_TO          - optional hex address to send to, otherwise sends to self.
 */
function startTxBroadcaster(client: EthereumClient) {
  const intervalEnv = process.env.ETH_TX_INTERVAL_MS
  const intervalMs = intervalEnv ? Number(intervalEnv) : NaN
  const log = client.config.logger

  if (!intervalEnv || Number.isNaN(intervalMs) || intervalMs <= 0) {
    log?.info('TX broadcaster disabled (set ETH_TX_INTERVAL_MS>0 to enable).')
    return
  }

  const accounts = client.config.accounts ?? []
  if (accounts.length === 0) {
    log?.warn(
      'TX broadcaster enabled but no unlocked account found (ETH_UNLOCK). Skipping.',
    )
    return
  }

  const [fromAddress, privKey] = accounts[0] // Account = [Address, Uint8Array]
  const toEnv = process.env.ETH_TX_TO
  const toAddress = toEnv ? toEnv : fromAddress.toString()

  const common = client.config.chainCommon
  const fullService = client.service as FullEthereumService

  let nextNonce: bigint | null = null

  const sendOnce = async () => {
    try {
      // Lazy-init nonce from state
        const execution = fullService.execution
        if (!execution) {
          log?.warn('TX broadcaster: no execution service available, cannot fetch nonce.')
          return
        }
        const vm = execution.vm
        const account = await vm.stateManager.getAccount(fromAddress)
        const nonceBigInt = BigInt(account.nonce.toString())
        nextNonce = nonceBigInt 
        log?.info(`TX broadcaster: starting nonce=${nextNonce.toString()}`)

      const nonce = nextNonce!
      const chainId = BigInt(common.chainId())

      const value = 1n // tiny value just to mutate state

      // Use legacy gasPrice tx (works across HFs / devnets)
      const txData = {
        nonce,
        gasPrice: 1_000_000_000n, // 1 gwei
        gasLimit: 21000n,
        to: createAddressFromString(toAddress),
        value,
        data: new Uint8Array([]),
        chainId,
      }

      const tx = createTx(txData, { common }).sign(privKey)
      await fullService.txPool?.add(tx)
      const hash = bytesToHex(tx.hash())
      log?.info(
        `TX broadcaster: broadcasted tx hash=${hash} nonce=${nonce.toString()} value=${value.toString()} to=${toAddress}`,
      )

    } catch (err: any) {
      log?.error(`TX broadcaster error: ${err?.message ?? String(err)}`)
    }
  }

  log?.info(
    `TX broadcaster enabled: interval=${intervalMs}ms, from=${fromAddress.toString()}, to=${toAddress}`,
  )

  setInterval(() => {
    void sendOnce()
  }, intervalMs)
}

/**
 * Starts and returns the {@link EthereumClient}
 */
async function startClient(
  config: Config,
  genesisMeta: { genesisState?: GenesisState; genesisStateRoot?: Uint8Array } = {},
) {
  config.logger?.info(`Data directory: ${config.datadir}`)

  const dbs = initDBs(config)

  let blockchain
  if (genesisMeta.genesisState !== undefined || genesisMeta.genesisStateRoot !== undefined) {
    let validateConsensus = false
    const consensusDict: ConsensusDict = {}
    if (config.chainCommon.consensusAlgorithm() === ConsensusAlgorithm.Clique) {
      consensusDict[ConsensusAlgorithm.Clique] = new CliqueConsensus()
      validateConsensus = true
    }

    blockchain = await createBlockchain({
      db: new LevelDB(dbs.chainDB),
      ...genesisMeta,
      common: config.chainCommon,
      hardforkByHeadBlockNumber: true,
      validateBlocks: true,
      validateConsensus,
      consensusDict,
      genesisState: genesisMeta.genesisState,
    })
    config.chainCommon.setForkHashes(blockchain.genesisBlock.hash())
  }

  const client = await EthereumClient.create({
    config,
    blockchain,
    ...genesisMeta,
    ...dbs,
  })
  await client.open()

  if (args.loadBlocksFromRlp !== undefined) {
    // Specifically for Hive simulator, preload blocks provided in RLP format
    const blocks: Block[] = []
    for (const rlpBlock of args.loadBlocksFromRlp) {
      const blockRlp = readFileSync(rlpBlock)
      let buf = RLP.decode(blockRlp, true)
      while (buf.data?.length > 0 || buf.remainder?.length > 0) {
        try {
          const block = createBlockFromBytesArray(buf.data as BlockBytes, {
            common: config.chainCommon,
            setHardfork: true,
          })
          blocks.push(block)
          buf = RLP.decode(buf.remainder, true)
          config.logger?.info(
            `Preloading block hash=${short(bytesToHex(block.header.hash()))} number=${
              block.header.number
            }`,
          )
        } catch (err: any) {
          config.logger?.info(
            `Encountered error while while preloading chain data  error=${err.message}`,
          )
          break
        }
      }
    }

    if (blocks.length > 0) {
      if (!client.chain.opened) {
        await client.chain.open()
      }

      await client.chain.putBlocks(blocks, true)
    }
  }

  if (typeof args.startBlock === 'number') {
    await startBlock(client)
  }

  // Update sync status (for logging/metrics)
  client.config.updateSynchronizedState(client.chain.headers.latest)

  // Always ensure txPool is running (critical for local/dev mining)
  const fullService = client.service as FullEthereumService
  fullService.txPool?.checkRunState()

  await client.start()

  if (args.loadBlocksFromRlp !== undefined && client.chain.opened) {
    const service = client.service
    await service.execution.open()
    await service.execution.run()
  }
  return client
}

/**
 * Shuts down an actively running client gracefully
 * @param config Client config object
 * @param clientStartPromise promise that returns a client and server object
 */
const stopClient = async (
  config: Config,
  clientStartPromise: Promise<{
    client: EthereumClient
    servers: (RPCServer | http.Server)[]
  } | null>,
) => {
  config.logger?.info('Caught interrupt signal. Obtaining client handle for clean shutdown...')
  config.logger?.info('(This might take a little longer if client not yet fully started)')
  let timeoutHandle: NodeJS.Timeout | undefined
  if (clientStartPromise?.toString().includes('Promise') === true) {
    // Client hasn't finished starting up so setting timeout to terminate process if not already shutdown gracefully
    timeoutHandle = setTimeout(() => {
      config.logger?.warn('Client has become unresponsive while starting up.')
      config.logger?.warn('Check logging output for potential errors.  Exiting...')
      process.exit(1)
    }, 30000)
  }
  const clientHandle = await clientStartPromise
  if (clientHandle !== null) {
    config.logger?.info('Shutting down the client and the servers...')
    const { client, servers } = clientHandle
    for (const s of servers) {
      // jayson.Server type doesn't play well with ESM for some reason
      if ((s as any)['http'] !== undefined) {
        ;(s as RPCServer).http().close()
      } else {
        ;(s as http.Server).close()
      }
    }
    await client.stop()
    config.logger?.info('Exiting.')
  } else {
    config.logger?.info('Client did not start properly, exiting ...')
  }
  if (timeoutHandle) clearTimeout(timeoutHandle)
  process.exit()
}

/**
 * Main entry point to start a client
 */
async function run() {
  if (args.helpRPC === true) {
    // Output RPC help and exit
    return helpRPC()
  }

  const { config, customGenesisState, metricsServer } = await generateClientConfig(args)

  logger = config.logger

  console.log(config)
  const clientStartPromise = startClient(config, {
    genesisState: customGenesisState,
  })
    .then((client) => {
      const servers: (RPCServer | http.Server)[] =
        args.rpc === true || args.rpcEngine === true || args.ws === true
          ? startRPCServers(client, args as RPCArgs)
          : []
      if (
        client.config.chainCommon.gteHardfork(Hardfork.Paris) &&
        (args.rpcEngine === false || args.rpcEngine === undefined)
      ) {
        config.logger?.warn(`Engine RPC endpoint not activated on a post-Merge HF setup.`)
      }
      if (metricsServer !== undefined) servers.push(metricsServer)

      // Start tx broadcaster (only meaningful when not in executeBlocks debug mode)
      // if (args.executeBlocks === undefined) {
      //   startTxBroadcaster(client)
      // }

      config.superMsg('Client started successfully')
      return { client, servers }
    })
    .catch((e) => {
      config.logger?.error('Error starting client', e)
      return null
    })

  process.on('SIGINT', async () => {
    await stopClient(config, clientStartPromise)
  })

  process.on('SIGTERM', async () => {
    await stopClient(config, clientStartPromise)
  })

  process.on('uncaughtException', (err) => {
    config.logger?.error(`Uncaught error: ${err.message}`)
    config.logger?.error(err)

    void stopClient(config, clientStartPromise)
  })
}

run().catch((err) => {
  /* eslint-disable no-console */
  console.log(err)
  logger?.error(err.message.toString()) ?? console.error(err)
  /* eslint-enable no-console */
})
