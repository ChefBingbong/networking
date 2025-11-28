#!/usr/bin/env tsx
/**
 * Test Network Script
 * 
 * Spins up 5 EthereumJS client nodes on a fresh test network with Clique consensus.
 * Based on the client startup code pattern.
 */

import type { AbstractLevel } from 'abstract-level'
import { mkdirSync } from 'fs'
import { Level } from 'level'
import { CliqueConsensus, createBlockchain, type ConsensusDict } from '../src/blockchain/index.ts'
import { ConsensusAlgorithm, Hardfork, type GenesisState } from '../src/chain-config/index.ts'
import { EthereumClient } from '../src/client/client.ts'
import { Config, DataDirectory } from '../src/client/config.ts'
import { LevelDB } from '../src/client/execution/level.ts'
import type { FullEthereumService } from '../src/client/service/fullethereumservice.ts'
import { ClientOpts } from '../src/client/types.ts'
import { Address, EthereumJSErrorWithoutCode, privateToAddress, randomBytes } from '../src/utils/index.ts'

const NUM_NODES = 5
const BASE_PORT = 30303
const MINE_PERIOD = 5 // seconds

// Pre-funded accounts for testing
const ACCOUNTS = Array.from({ length: 10 }, (_, i) => {
  const privateKeyBytes = randomBytes(32)
  privateKeyBytes[0] = i
  privateKeyBytes[1] = 0
  const addressBytes = privateToAddress(privateKeyBytes)
  return {
    privateKey: privateKeyBytes,
    address: new Address(addressBytes),
  }
})

// Clique signer addresses (all nodes will be signers)
const SIGNER_ADDRESSES: Address[] = []

// Initialize signer addresses for all nodes
function initializeSignerAddresses() {
  SIGNER_ADDRESSES.length = 0
  for (let i = 0; i < NUM_NODES; i++) {
    const nodePrivateKey = randomBytes(32)
    nodePrivateKey[0] = i + 100
    nodePrivateKey[1] = 0
    const nodeAddress = privateToAddress(nodePrivateKey)
    SIGNER_ADDRESSES.push(new Address(nodeAddress))
  }
}

let logger: Logger | undefined

const args: ClientOpts = getArgs()

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
    // `Level` and `AbstractLevel` somehow have a few property differences even though
    // `Level` extends `AbstractLevel`.  We don't use any of the missing properties so
    // just ignore this error
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



  if (typeof args.startBlock === 'number') {
    await startBlock(client)
  }

  // update client's sync status and start txpool if synchronized
  client.config.updateSynchronizedState(client.chain.headers.latest)
  if (client.config.synchronized === true) {
    const fullService = client.service
    // The service might not be FullEthereumService even if we cast it as one,
    // so txPool might not exist on it
    ;(fullService as FullEthereumService).txPool?.checkRunState()
  }

  if (args.executeBlocks !== undefined) {
    // Special block execution debug mode (does not change any state)
    await executeBlocks(client)
  } else {
    // Regular client start
    await client.start()
  }

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
    servers:any[]
  } | null>,
) => {
  config.logger?.info('Caught interrupt signal. Obtaining client handle for clean shutdown...')
  config.logger?.info('(This might take a little longer if client not yet fully started)')
  let timeoutHandle
  if (clientStartPromise?.toString().includes('Promise') === true)
    // Client hasn't finished starting up so setting timeout to terminate process if not already shutdown gracefully
    timeoutHandle = setTimeout(() => {
      config.logger?.warn('Client has become unresponsive while starting up.')
      config.logger?.warn('Check logging output for potential errors.  Exiting...')
      process.exit(1)
    }, 30000)
  const clientHandle = await clientStartPromise
  if (clientHandle !== null) {
    config.logger?.info('Shutting down the client and the servers...')
    const { client, servers } = clientHandle
    for (const s of servers) {
      //@ts-expect-error jayson.Server type doesn't play well with ESM for some reason
      s['http'] !== undefined ? (s as RPCServer).http().close() : (s as http.Server).close()
    }
    await client.stop()
    config.logger?.info('Exiting.')
  } else {
    config.logger?.info('Client did not start properly, exiting ...')
  }
  clearTimeout(timeoutHandle)
  process.exit()
}

/**
 * Main entry point to start a client
 */
async function run() {


  const { config, customGenesisState, metricsServer } = await generateClientConfig(args)

  logger = config.logger

  // Do not wait for client to be fully started so that we can hookup SIGINT handling
  // else a SIGINT before may kill the process in unclean manner
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
    // Handles uncaught exceptions that are thrown in async events/functions and aren't caught in
    // main client process
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
