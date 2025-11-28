#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs'
import * as http from 'http'
import { homedir } from 'os'
import * as path from 'path'
import process from 'process'
import * as readline from 'readline'
import repl from 'repl'
import * as url from 'url'

import { trustedSetup } from '@paulmillr/trusted-setups'
import {
    keccak256 as keccak256WASM,
    secp256k1Expand,
    secp256k1Recover,
    secp256k1Sign,
    waitReady as waitReadyPolkadotSha256,
    sha256 as wasmSha256,
} from '@polkadot/wasm-crypto'
import { keccak256 } from 'ethereum-cryptography/keccak.js'
import { secp256k1 } from 'ethereum-cryptography/secp256k1.js'
import { sha256 } from 'ethereum-cryptography/sha256.js'
import { Level } from 'level'
import { KZG as microEthKZG } from 'micro-eth-signer/kzg.js'
import * as promClient from 'prom-client'

// ------- Local imports -------

import type { Block, BlockBytes } from '../../block/index.ts'
import { createBlockFromBytesArray } from '../../block/index.ts'

import type { ConsensusDict } from '../../blockchain/index.ts'
import { CliqueConsensus, createBlockchain } from '../../blockchain/index.ts'

import type {
    CustomCrypto,
    GenesisState,
    GethGenesis,
} from '../../chain-config/index.ts'
import {
    Chain,
    Common,
    ConsensusAlgorithm,
    Hardfork,
    Mainnet,
    createCommonFromGethGenesis,
    createCustomCommon,
    getPresetChainConfig,
    parseGethGenesisState,
} from '../../chain-config/index.ts'

import * as RLP from '../../rlp/index.ts'
import { createTx } from '../../tx/transactionFactory.ts'

import type { Address, PrefixedHexString } from '../../utils/index.ts'
import {
    EthereumJSErrorWithoutCode,
    bytesToBigInt,
    bytesToHex,
    bytesToUnprefixedHex,
    calculateSigRecovery,
    concatBytes,
    createAddressFromPrivateKey,
    createAddressFromString,
    ecrecover,
    hexToBytes,
    randomBytes,
    setLengthLeft,
    short,
} from '../../utils/index.ts'

import { EthereumClient } from '../client.ts'
import type { FullEthereumService } from '../service/fullethereumservice.ts'

import { Config, DataDirectory, SyncMode } from '../config.ts'
import type { Logger } from '../logging.ts'
import { getLogger } from '../logging.ts'

import { LevelDB } from '../execution/level.ts'

import { RPCManager, saveReceiptsMethods } from '../../client/rpc/index.ts'
import * as modules from '../../client/rpc/modules/index.ts'

import {
    MethodConfig,
    createRPCServer,
    createRPCServerListener,
    createWsRPCServerListener,
    parseMultiaddrs,
} from '../util/index.ts'
import { setupMetrics } from '../util/metrics.ts'

import type { ClientOpts } from '../types.ts'
import { Event } from '../types.ts'

import type { AbstractLevel } from 'abstract-level'
import type { Server as RPCServer } from 'jayson/promise/index.js'

// ----------------- Types & helpers -----------------

type Account = [address: Address, privateKey: Uint8Array]

type RPCArgs = {
  rpc: boolean
  rpcAddr: string
  rpcPort: number
  ws: boolean
  wsPort: number
  wsAddr: string
  rpcEngine: boolean
  rpcEngineAddr: string
  rpcEnginePort: number
  wsEngineAddr: string
  wsEnginePort: number
  rpcDebug: string
  rpcDebugVerbose: string
  helpRPC: boolean
  jwtSecret?: string
  rpcEngineAuth: boolean
  rpcCors: string
}

let logger: Logger | undefined

// Simple env helpers
const envBool = (name: string, def = false): boolean => {
  const v = process.env[name]
  if (v === undefined) return def
  const lc = v.toLowerCase()
  return lc === 'true' || lc === '1' || lc === 'yes'
}
const envNum = (name: string, def: number): number => {
  const v = process.env[name]
  if (v === undefined) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

// ----------------- ENV → ClientOpts -----------------

function getEnvArgs(): ClientOpts {
  const dataDir = process.env.ETH_DATA_DIR ?? `${homedir()}/.ethereumjs-devnet`

  return {
    // basic chain selection
    network: (process.env.ETH_NETWORK as any) ?? 'devnet',
    chainId: process.env.ETH_CHAIN_ID ? Number(process.env.ETH_CHAIN_ID) : undefined,
    networkId: undefined,

    // sync / data
    sync: SyncMode.Full ?? (SyncMode as any).Full ?? SyncMode.Full ?? Config.SYNCMODE_DEFAULT,
    dataDir,

    // custom chain / genesis (rarely used in your case)
    customChain: process.env.ETH_CUSTOM_CHAIN_PATH,
    customGenesisState: process.env.ETH_CUSTOM_GENESIS_STATE_PATH,
    gethGenesis: process.env.ETH_GETH_GENESIS_PATH,
    trustedSetup: process.env.ETH_TRUSTED_SETUP_PATH,

    // p2p
    bootnodes: process.env.ETH_BOOTNODES
      ? process.env.ETH_BOOTNODES.split(',').filter(Boolean)
      : undefined,
    port: envNum('ETH_PORT', Config.PORT_DEFAULT),
    extIP: process.env.ETH_EXT_IP,
    multiaddrs: process.env.ETH_MULTIADDRS
      ? process.env.ETH_MULTIADDRS.split(',').filter(Boolean)
      : undefined,

    // RPC / WS
    rpc: envBool('ETH_RPC', true),
    rpcPort: envNum('ETH_RPC_PORT', 8545),
    rpcAddr: process.env.ETH_RPC_ADDR ?? '127.0.0.1',
    ws: envBool('ETH_WS', false),
    wsPort: envNum('ETH_WS_PORT', 8546),
    wsAddr: process.env.ETH_WS_ADDR ?? '127.0.0.1',

    // Engine RPC
    rpcEngine: envBool('ETH_RPC_ENGINE', true),
    rpcEnginePort: envNum('ETH_RPC_ENGINE_PORT', 8551),
    rpcEngineAddr: process.env.ETH_RPC_ENGINE_ADDR ?? '127.0.0.1',
    wsEnginePort: envNum('ETH_WS_ENGINE_PORT', 8552),
    wsEngineAddr: process.env.ETH_WS_ENGINE_ADDR ?? '127.0.0.1',
    rpcEngineAuth: envBool('ETH_RPC_ENGINE_AUTH', false),
    jwtSecret: process.env.ETH_JWT_SECRET_PATH,

    helpRPC: envBool('ETH_HELP_RPC', false),

    // logging
    logLevel: (process.env.ETH_LOG_LEVEL as any) ?? 'info',
    logFile: process.env.ETH_LOG_FILE === 'false' ? false : true,
    logLevelFile: 'debug',
    logRotate: true,
    logMaxFiles: envNum('ETH_LOG_MAX_FILES', 5),

    // Prometheus
    prometheus: envBool('ETH_PROMETHEUS', false),
    prometheusPort: envNum('ETH_PROMETHEUS_PORT', 8000),

    // RPC debug
    rpcDebug: process.env.ETH_RPC_DEBUG ?? '',
    rpcDebugVerbose: process.env.ETH_RPC_DEBUG_VERBOSE ?? '',
    rpcCors: process.env.ETH_RPC_CORS ?? '*',

    // performance / peers defaults
    maxPerRequest: Config.MAXPERREQUEST_DEFAULT,
    maxFetcherJobs: Config.MAXFETCHERJOBS_DEFAULT,
    minPeers: Config.MINPEERS_DEFAULT,
    maxPeers: Config.MAXPEERS_DEFAULT,
    dnsAddr: Config.DNSADDR_DEFAULT,
    dnsNetworks: process.env.ETH_DNS_NETWORKS
      ? process.env.ETH_DNS_NETWORKS.split(',').filter(Boolean)
      : undefined,

    // execution
    execution: Config.EXECUTION,
    numBlocksPerIteration: Config.NUM_BLOCKS_PER_ITERATION,
    executeBlocks: undefined,

    // caches
    accountCache: Config.ACCOUNT_CACHE,
    storageCache: Config.STORAGE_CACHE,
    codeCache: Config.CODE_CACHE,
    trieCache: Config.TRIE_CACHE,

    // misc
    debugCode: Config.DEBUGCODE_DEFAULT,
    discDns: envBool('ETH_DISC_DNS', false),
    discV4: envBool('ETH_DISC_V4', true),

    // mining / devnet
    mine: envBool('ETH_MINE', false),
    unlock: process.env.ETH_UNLOCK,
    dev: (process.env.ETH_DEV as any) ?? 'poa',
    minerCoinbase: process.env.ETH_MINER_COINBASE
      ? createAddressFromString(process.env.ETH_MINER_COINBASE)
      : undefined,

    // receipts / snap
    saveReceipts: envBool('ETH_SAVE_RECEIPTS', true),
    snap: envBool('ETH_SNAP', false),
    prefixStorageTrieKeys: true,
    useStringValueTrieDB: false,

    // tx lookup
    txLookupLimit: envNum('ETH_TX_LOOKUP_LIMIT', 2350000),

    startBlock: process.env.ETH_START_BLOCK ? Number(process.env.ETH_START_BLOCK) : undefined,
    isSingleNode: envBool('ETH_SINGLE_NODE', false),

    vmProfileBlocks: false,
    vmProfileTxs: false,

    loadBlocksFromRlp: process.env.ETH_LOAD_BLOCKS_RLP
      ? process.env.ETH_LOAD_BLOCKS_RLP.split(',').filter(Boolean)
      : undefined,

    pruneEngineCache: true,
    engineNewpayloadMaxExecute: undefined,
    skipEngineExec: false,

    useJsCrypto: envBool('ETH_USE_JS_CRYPTO', false),
  }
}

// ----------------- Devnet setup / accounts / crypto -----------------

async function setupDevnet(prefundAddress: Address, args: ClientOpts) {
  const addr = prefundAddress.toString().slice(2)
  const consensusConfig =
    args.dev === 'pow'
      ? { ethash: true }
      : {
          clique: {
            period: 10,
            epoch: 30000,
          },
        }

  const defaultChainData: GethGenesis = {
    config: {
      chainId: 123456,
      homesteadBlock: 0,
      eip150Block: 0,
      eip150Hash:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      eip155Block: 0,
      eip158Block: 0,
      byzantiumBlock: 0,
      constantinopleBlock: 0,
      petersburgBlock: 0,
      istanbulBlock: 0,
      berlinBlock: 0,
      londonBlock: 0,
      ...consensusConfig,
    },
    nonce: '0x0',
    timestamp: '0x614b3731',
    gasLimit: '0x47b760',
    difficulty: '0x1',
    mixHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    coinbase: '0x0000000000000000000000000000000000000000',
    number: '0x0',
    gasUsed: '0x0',
    parentHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    baseFeePerGas: 7,
    alloc: {},
  }

  const extraData =
    args.dev === 'pow'
      ? '0x' + '0'.repeat(32)
      : '0x' + '0'.repeat(64) + addr + '0'.repeat(130)

  const chainData = {
    ...defaultChainData,
    extraData,
    alloc: { [addr]: { balance: '0x10000000000000000000' } },
  }

  const common = createCommonFromGethGenesis(chainData, {
    chain: 'devnet',
    hardfork: Hardfork.London,
  })
  const customGenesisState = parseGethGenesisState(chainData)
  return { common, customGenesisState }
}

async function inputAccounts(args: ClientOpts): Promise<Account[]> {
  const accounts: Account[] = []

  const rl = readline.createInterface({
    // @ts-ignore
    input: process.stdin,
    // @ts-ignore
    output: process.stdout,
  })

  // Hide key input
  rl['input'].on('keypress', function () {
    const len = (rl as any).line.length
    readline.moveCursor((rl as any).output, -len, 0)
    readline.clearLine((rl as any).output, 1)
    for (let i = 0; i < len; i++) {
      rl['output'].write('*')
    }
  })

  const question = (text: string) =>
    new Promise<string>((resolve) => rl.question(text, resolve))

  try {
    const addresses = args.unlock!.split(',')
    const isFile = existsSync(path.resolve(addresses[0]))
    if (!isFile) {
      for (const addressString of addresses) {
        const address = createAddressFromString(addressString)
        const inputKey = (await question(
          `Please enter the 0x-prefixed private key to unlock ${address}:\n`,
        )) as PrefixedHexString
        rl['history'] = rl['history'].slice(1)
        const privKey = hexToBytes(inputKey)
        const derivedAddress = createAddressFromPrivateKey(privKey)
        if (address.equals(derivedAddress) === true) {
          accounts.push([address, privKey])
        } else {
          throw EthereumJSErrorWithoutCode(
            `Private key does not match for ${address} (address derived: ${derivedAddress})`,
          )
        }
      }
    } else {
      const acc = readFileSync(path.resolve(args.unlock!), 'utf-8').replace(
        /(\r\n|\n|\r)/gm,
        '',
      )
      const privKey = hexToBytes(`0x${acc}`)
      const derivedAddress = createAddressFromPrivateKey(privKey)
      accounts.push([derivedAddress, privKey])
    }
  } catch (e: any) {
    throw EthereumJSErrorWithoutCode(
      `Encountered error unlocking account:\n${e.message}`,
    )
  }
  rl.close()
  return accounts
}

function generateAccount(): Account {
  const privKey = randomBytes(32)
  const address = createAddressFromPrivateKey(privKey)
  /* eslint-disable no-console */
  console.log('='.repeat(50))
  console.log('Account generated for mining blocks:')
  console.log(`Address: ${address}`)
  console.log(`Private key: ${bytesToHex(privKey)}`)
  console.log('WARNING: Do not use this account for mainnet funds')
  console.log('='.repeat(50))
  /* eslint-enable no-console */
  return [address, privKey]
}

async function getCryptoFunctions(useJsCrypto: boolean): Promise<CustomCrypto> {
  const cryptoFunctions: CustomCrypto = {}

  const kzg = new microEthKZG(trustedSetup)
  if (useJsCrypto === false) {
    await waitReadyPolkadotSha256()
    cryptoFunctions.keccak256 = keccak256WASM
    cryptoFunctions.ecrecover = (
      msgHash: Uint8Array,
      v: bigint,
      r: Uint8Array,
      s: Uint8Array,
      chainID?: bigint,
    ) =>
      secp256k1Expand(
        secp256k1Recover(
          msgHash,
          concatBytes(setLengthLeft(r, 32), setLengthLeft(s, 32)),
          Number(calculateSigRecovery(v, chainID)),
        ),
      ).slice(1)
    cryptoFunctions.sha256 = wasmSha256
    cryptoFunctions.ecsign = (msg: Uint8Array, pk: Uint8Array) => {
      const buf = secp256k1Sign(msg, pk)
      const r = bytesToBigInt(buf.slice(0, 32))
      const s = bytesToBigInt(buf.slice(32, 64))
      const recovery = buf[64]
      return { r, s, recovery }
    }
    cryptoFunctions.ecdsaRecover = (
      sig: Uint8Array,
      recId: number,
      hash: Uint8Array,
    ) => {
      return secp256k1Recover(hash, sig, recId)
    }
  } else {
    cryptoFunctions.keccak256 = keccak256
    cryptoFunctions.ecrecover = ecrecover
    cryptoFunctions.sha256 = sha256
    cryptoFunctions.ecsign = secp256k1.sign
    cryptoFunctions.ecdsaRecover = (
      sig: Uint8Array,
      recId: number,
      hash: Uint8Array,
    ) => {
      const sign = secp256k1.Signature.fromCompact(sig)
      const point = sign.addRecoveryBit(recId).recoverPublicKey(hash)
      const address = point.toRawBytes(true)
      return address
    }
  }
  cryptoFunctions.kzg = kzg
  return cryptoFunctions
}

// ----------------- generateClientConfig (env-based) -----------------

async function generateClientConfig(args: ClientOpts) {
  const chainName = args.chainId ?? args.networkId ?? args.network ?? Chain.Mainnet
  const chain = getPresetChainConfig(chainName)

  const cryptoFunctions = await getCryptoFunctions(args.useJsCrypto ?? false)

  const accounts: Account[] = []
  if (typeof args.unlock === 'string') {
    accounts.push(...(await inputAccounts(args)))
  }

  let customGenesisState: GenesisState | undefined
  let common = new Common({
    chain,
    hardfork: Hardfork.Chainstart,
    customCrypto: cryptoFunctions,
  })

  const devEnabled =
    args.dev === true || (typeof args.dev === 'string' && args.dev !== 'false')

  if (devEnabled) {
    args.discDns = false
    if (accounts.length === 0) {
      rmSync(`${args.dataDir}/devnet`, { recursive: true, force: true })
      accounts.push(generateAccount())
    }
    const prefundAddress = accounts[0][0]
    ;({ common, customGenesisState } = await setupDevnet(prefundAddress, args))
  }

  if (typeof args.customChain === 'string') {
    try {
      const customChainParams = JSON.parse(readFileSync(args.customChain, 'utf-8'))
      customGenesisState = JSON.parse(
        readFileSync(args.customGenesisState!, 'utf-8'),
      )
      common = createCustomCommon(customChainParams, Mainnet, {
        customCrypto: cryptoFunctions,
      })
    } catch (err: any) {
      throw EthereumJSErrorWithoutCode(`invalid chain parameters: ${err.message}`)
    }
  } else if (typeof args.gethGenesis === 'string') {
    const genesisFile = JSON.parse(readFileSync(args.gethGenesis, 'utf-8'))
    const chainName = path.parse(args.gethGenesis).base.split('.')[0]
    common = createCommonFromGethGenesis(genesisFile, {
      chain: chainName,
    })
    // @ts-expect-error
    common.customCrypto = cryptoFunctions
    customGenesisState = parseGethGenesisState(genesisFile)
  }

  if (args.mine === true && accounts.length === 0) {
    throw EthereumJSErrorWithoutCode(
      'Please provide an account to mine blocks with `ETH_UNLOCK` or use `ETH_DEV` to generate',
    )
  }

  const datadir = args.dataDir ?? Config.DATADIR_DEFAULT
  const networkDir = `${datadir}/${common.chainName()}`
  const configDirectory = `${networkDir}/config`
  mkdirSync(configDirectory, { recursive: true })
  const invalidPayloadsDir = `${networkDir}/invalidPayloads`
  mkdirSync(invalidPayloadsDir, { recursive: true })

  const key = await Config.getClientKey(datadir, common)

  if (typeof args.logFile === 'boolean') {
    args.logFile = args.logFile ? `${networkDir}/ethereumjs.log` : undefined
  }

  const logger: Logger | undefined = getLogger(args)
  let bootnodes
  if (args.bootnodes !== undefined) {
    if (
      Array.isArray(args.bootnodes) &&
      args.bootnodes.length === 1 &&
      args.bootnodes[0].includes('.txt')
    ) {
      const file = readFileSync(args.bootnodes[0], 'utf-8')
      let nodeURLs = file
        .split(/\r?\n/)
        .filter((u) => (u !== '' ? true : false))
      nodeURLs = nodeURLs.map((u) => {
        const discportIndex = u.indexOf('?discport')
        return discportIndex > 0 ? u.substring(0, discportIndex) : u
      })
      bootnodes = parseMultiaddrs(nodeURLs)
      logger?.info(
        `Reading bootnodes file=${args.bootnodes[0]} num=${nodeURLs.length}`,
      )
    } else {
      bootnodes = parseMultiaddrs(args.bootnodes)
    }
  }

  const multiaddrs =
    args.multiaddrs !== undefined ? parseMultiaddrs(args.multiaddrs) : undefined
  const mine = args.mine ?? args.dev !== undefined
  const isSingleNode = args.isSingleNode ?? args.dev !== undefined

  let prometheusMetrics = undefined
  let metricsServer: http.Server | undefined
  if (args.prometheus === true) {
    prometheusMetrics = setupMetrics()
    const register = new promClient.Registry()
    register.setDefaultLabels({
      app: 'ethereumjs-client',
    })
    promClient.collectDefaultMetrics({ register })
    for (const [, metric] of Object.entries(prometheusMetrics)) {
      register.registerMetric(metric)
    }

    metricsServer = http.createServer(async (req, res) => {
      if (req.url === undefined) {
        res.statusCode = 400
        res.end('Bad Request: URL is missing')
        return
      }
      const reqUrl = new url.URL(req.url, `http://${req.headers.host}`)
      const route = reqUrl.pathname

      switch (route) {
        case '/metrics':
          res.setHeader('Content-Type', register.contentType)
          res.end(await register.metrics())
          break
        default:
          res.statusCode = 404
          res.end('Not found')
          return
      }
    })
    logger?.info(`Starting Metrics Server on port ${args.prometheusPort}`)
    metricsServer.listen(args.prometheusPort)
  }

  const config = new Config({
    accounts,
    bootnodes,
    common,
    datadir,
    debugCode: args.debugCode,
    discDns: args.discDns,
    discV4: args.discV4,
    dnsAddr: args.dnsAddr,
    execution: args.execution,
    numBlocksPerIteration: args.numBlocksPerIteration,
    accountCache: args.accountCache,
    storageCache: args.storageCache,
    codeCache: args.codeCache,
    trieCache: args.trieCache,
    dnsNetworks: args.dnsNetworks,
    extIP: args.extIP,
    key,
    logger,
    maxPeers: args.maxPeers,
    maxPerRequest: args.maxPerRequest,
    maxFetcherJobs: args.maxFetcherJobs,
    mine,
    minerCoinbase: args.minerCoinbase,
    isSingleNode,
    vmProfileBlocks: args.vmProfileBlocks,
    vmProfileTxs: args.vmProfileTxs,
    minPeers: args.minPeers,
    multiaddrs,
    port: args.port,
    saveReceipts: args.saveReceipts,
    syncmode: args.sync,
    prefixStorageTrieKeys: args.prefixStorageTrieKeys,
    enableSnapSync: args.snap,
    useStringValueTrieDB: args.useStringValueTrieDB,
    txLookupLimit: args.txLookupLimit,
    pruneEngineCache: args.pruneEngineCache,
    engineNewpayloadMaxExecute:
      args.skipEngineExec === true ? 0 : args.engineNewpayloadMaxExecute,
    prometheusMetrics,
  })

  config.events.on(Event.SERVER_LISTENING, (details) => {
    const ndir = config.getNetworkDirectory()
    try {
      writeFileSync(`${ndir}/${details.transport}`, details.url)
    } catch (e) {
      config.logger?.error(
        `Error writing listener details to disk: ${(e as Error).message}`,
      )
    }
  })

  if (customGenesisState !== undefined) {
    const numAccounts = Object.keys(customGenesisState).length
    config.logger?.info(
      `Reading custom genesis state accounts=${numAccounts}`,
    )
  }

  return { config, customGenesisState, metricsServer, common }
}

// ----------------- DB init, startBlock, tx broadcaster -----------------

function initDBs(config: Config): {
  chainDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
  stateDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
  metaDB: AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>
} {
  const chainDataDir = config.getDataDirectory(DataDirectory.Chain)
  mkdirSync(chainDataDir, { recursive: true })
  const chainDB = new Level<string | Uint8Array, string | Uint8Array>(
    chainDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  const stateDataDir = config.getDataDirectory(DataDirectory.State)
  mkdirSync(stateDataDir, { recursive: true })
  const stateDB = new Level<string | Uint8Array, string | Uint8Array>(
    stateDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  const metaDataDir = config.getDataDirectory(DataDirectory.Meta)
  mkdirSync(metaDataDir, { recursive: true })
  const metaDB = new Level<string | Uint8Array, string | Uint8Array>(
    metaDataDir,
  ) as unknown as AbstractLevel<string | Uint8Array, string | Uint8Array, string | Uint8Array>

  return { chainDB, stateDB, metaDB }
}

async function startBlock(client: EthereumClient, startBlockOpt?: number) {
  if (startBlockOpt === undefined) return
  const startBlock = BigInt(startBlockOpt)
  const height = client.chain.headers.height
  if (height < startBlock) {
    throw EthereumJSErrorWithoutCode(
      `Cannot start chain higher than current height ${height}`,
    )
  }
  try {
    await client.chain.resetCanonicalHead(startBlock)
    client.config.logger?.info(
      `Chain height reset to ${client.chain.headers.height}`,
    )
  } catch (err: any) {
    throw EthereumJSErrorWithoutCode(
      `Error setting back chain in startBlock: ${err}`,
    )
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

  const [fromAddress, privKey] = accounts[0]
  const toEnv = process.env.ETH_TX_TO
  const toAddress = toEnv ? toEnv : fromAddress.toString()

  const common = client.config.chainCommon
  const fullService = client.service as FullEthereumService

  let nextNonce: bigint | null = null

  const sendOnce = async () => {
    try {
      if (nextNonce === null) {
        const execution = fullService.execution
        if (!execution) {
          log?.warn(
            'TX broadcaster: no execution service available, cannot fetch nonce.',
          )
          return
        }
        const vm = execution.vm
        const account = await vm.stateManager.getAccount(fromAddress)
        const nonceBigInt = BigInt(account.nonce.toString())
        nextNonce = nonceBigInt
        log?.info(`TX broadcaster: starting nonce=${nextNonce.toString()}`)
      }

      const nonce = nextNonce!
      const chainId = BigInt(common.chainId())
      const value = 1n

      const txData = {
        nonce,
        gasPrice: 1_000_000_000n,
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

      nextNonce = nonce + 1n
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

// ----------------- Start client -----------------

async function startClient(
  config: Config,
  args: ClientOpts,
  genesisMeta: {
    genesisState?: GenesisState
    genesisStateRoot?: Uint8Array
  } = {},
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
            `Preloading block hash=${short(
              bytesToHex(block.header.hash()),
            )} number=${block.header.number}`,
          )
        } catch (err: any) {
          config.logger?.info(
            `Encountered error while preloading chain data  error=${err.message}`,
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
    await startBlock(client, args.startBlock)
  }

  client.config.updateSynchronizedState(client.chain.headers.latest)

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

// ----------------- RPC server helpers -----------------

function parseJwtSecret(config: Config, jwtFilePath?: string): Uint8Array {
  let jwtSecret: Uint8Array
  const defaultJwtPath = `${config.datadir}/jwtsecret`
  const usedJwtPath = jwtFilePath ?? defaultJwtPath

  if (jwtFilePath !== undefined && !existsSync(jwtFilePath)) {
    throw EthereumJSErrorWithoutCode(
      `No file exists at provided jwt secret path=${jwtFilePath}`,
    )
  }

  if (jwtFilePath !== undefined || existsSync(defaultJwtPath)) {
    const jwtSecretContents = readFileSync(
      jwtFilePath ?? defaultJwtPath,
      'utf-8',
    ).trim()
    const hexPattern = new RegExp(
      /^(0x|0X)?(?<jwtSecret>[a-fA-F0-9]+)$/,
      'g',
    )
    const jwtSecretHex = hexPattern.exec(jwtSecretContents)?.groups?.jwtSecret
    if (jwtSecretHex === undefined || jwtSecretHex.length !== 64) {
      throw Error('Need a valid 256 bit hex encoded secret')
    }
    jwtSecret = hexToBytes(`0x${jwtSecretHex}`)
  } else {
    const folderExists = existsSync(config.datadir)
    if (!folderExists) {
      mkdirSync(config.datadir, { recursive: true })
    }

    jwtSecret = randomBytes(32)
    writeFileSync(defaultJwtPath, bytesToUnprefixedHex(jwtSecret), {})
    config.logger?.info(
      `New Engine API JWT token created path=${defaultJwtPath}`,
    )
  }
  config.logger?.info(
    `Using Engine API with JWT token authentication path=${usedJwtPath}`,
  )
  return jwtSecret
}

function startRPCServers(client: EthereumClient, args: RPCArgs) {
  const { config } = client
  const servers: (http.Server | RPCServer)[] = []
  const {
    rpc,
    rpcAddr,
    rpcPort,
    ws,
    wsPort,
    wsAddr,
    rpcEngine,
    rpcEngineAddr,
    rpcEnginePort,
    wsEngineAddr,
    wsEnginePort,
    jwtSecret: jwtSecretPath,
    rpcEngineAuth,
    rpcCors,
    rpcDebug,
    rpcDebugVerbose,
  } = args

  const manager = new RPCManager(client, config)
  const { logger } = config
  const jwtSecret =
    rpcEngine && rpcEngineAuth
      ? parseJwtSecret(config, jwtSecretPath)
      : new Uint8Array(0)
  let withEngineMethods = false

  if ((rpc || rpcEngine) && !config.saveReceipts) {
    logger?.warn(
      `Starting client without --saveReceipts might lead to interop issues with a CL especially if the CL intends to propose blocks, omitting methods=${saveReceiptsMethods}`,
    )
  }

  if (rpc || ws) {
    let rpcHttpServer: http.Server | undefined
    withEngineMethods =
      rpcEngine && rpcEnginePort === rpcPort && rpcEngineAddr === rpcAddr

    const { server, namespaces, methods } = createRPCServer(manager, {
      methodConfig: withEngineMethods
        ? MethodConfig.WithEngine
        : MethodConfig.WithoutEngine,
      rpcDebugVerbose,
      rpcDebug,
      logger,
    })
    servers.push(server)

    if (rpc) {
      rpcHttpServer = createRPCServerListener({
        RPCCors: rpcCors,
        server,
        withEngineMiddleware:
          withEngineMethods && rpcEngineAuth
            ? {
                jwtSecret,
                unlessFn: (req: any) =>
                  Array.isArray(req.body)
                    ? req.body.some(
                        (r: any) => r.method.includes('engine_'),
                      ) === false
                    : req.body.method.includes('engine_') === false,
              }
            : undefined,
      })
      rpcHttpServer.listen(rpcPort, rpcAddr)
      logger?.info(
        `Started JSON RPC Server address=http://${rpcAddr}:${rpcPort} namespaces=${namespaces}${
          withEngineMethods
            ? ' rpcEngineAuth=' + rpcEngineAuth.toString()
            : ''
        }`,
      )
      logger?.debug(
        `Methods available at address=http://${rpcAddr}:${rpcPort} namespaces=${namespaces} methods=${Object.keys(
          methods,
        ).join(',')}`,
      )
    }
    if (ws) {
      const opts: any = {
        rpcCors,
        server,
        withEngineMiddleware:
          withEngineMethods && rpcEngineAuth ? { jwtSecret } : undefined,
      }
      if (rpcAddr === wsAddr && rpcPort === wsPort && rpcHttpServer) {
        opts.httpServer = rpcHttpServer
      }

      const rpcWsServer = createWsRPCServerListener(opts)
      if (rpcWsServer) rpcWsServer.listen(wsPort)
      logger?.info(
        `Started JSON RPC Server address=ws://${wsAddr}:${wsPort} namespaces=${namespaces}${
          withEngineMethods ? ` rpcEngineAuth=${rpcEngineAuth}` : ''
        }`,
      )
      logger?.debug(
        `Methods available at address=ws://${wsAddr}:${wsPort} namespaces=${namespaces} methods=${Object.keys(
          methods,
        ).join(',')}`,
      )
    }
  }

  if (rpcEngine && !(rpc && rpcPort === rpcEnginePort && rpcAddr === rpcEngineAddr)) {
    const { server, namespaces, methods } = createRPCServer(manager, {
      methodConfig: MethodConfig.EngineOnly,
      rpcDebug,
      rpcDebugVerbose,
      logger,
    })
    servers.push(server)
    const rpcHttpServer = createRPCServerListener({
      RPCCors: rpcCors,
      server,
      withEngineMiddleware: rpcEngineAuth ? { jwtSecret } : undefined,
    })
    rpcHttpServer.listen(rpcEnginePort, rpcEngineAddr)
    logger?.info(
      `Started JSON RPC server address=http://${rpcEngineAddr}:${rpcEnginePort} namespaces=${namespaces} rpcEngineAuth=${rpcEngineAuth}`,
    )
    logger?.debug(
      `Methods available at address=http://${rpcEngineAddr}:${rpcEnginePort} namespaces=${namespaces} methods=${Object.keys(
        methods,
      ).join(',')}`,
    )

    if (ws) {
      const opts: any = {
        rpcCors,
        server,
        withEngineMiddleware: rpcEngineAuth ? { jwtSecret } : undefined,
      }

      if (rpcEngineAddr === wsEngineAddr && rpcEnginePort === wsEnginePort) {
        opts.httpServer = rpcHttpServer
      }

      const rpcWsServer = createWsRPCServerListener(opts)
      if (rpcWsServer) rpcWsServer.listen(wsEnginePort, wsEngineAddr)
      logger?.info(
        `Started JSON RPC Server address=ws://${wsEngineAddr}:${wsEnginePort} namespaces=${namespaces} rpcEngineAuth=${rpcEngineAuth}`,
      )
      logger?.debug(
        `Methods available at address=ws://${wsEngineAddr}:${wsEnginePort} namespaces=${namespaces} methods=${Object.keys(
          methods,
        ).join(',')}`,
      )
    }
  }

  return servers
}

function helpRPC() {
  /* eslint-disable no-console */
  console.log('-'.repeat(27))
  console.log('JSON-RPC: Supported Methods')
  console.log('-'.repeat(27))
  console.log()
  for (const modName of modules.list) {
    console.log(`${modName}:`)
    const methods = RPCManager.getMethodNames((modules as any)[modName])
    for (const methodName of methods) {
      console.log(`-> ${modName.toLowerCase()}_${methodName}`)
    }
    console.log()
  }
  console.log()
  /* eslint-enable no-console */
  process.exit()
}

// ----------------- REPL -----------------

function activateRPCMethods(
  replServer: repl.REPLServer,
  allRPCMethods: any,
  client: EthereumClient,
) {
  function defineRPCAction(
    context: repl.REPLServer,
    methodName: string,
    params: string,
  ) {
    let parsedParams: any = []
    if (params !== undefined && params.length > 0) {
      try {
        parsedParams = JSON.parse(params)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('Failed to parse params as JSON', e)
      }
    }
    allRPCMethods[methodName]
      .handler(parsedParams)
      .then((result: any) => console.log(result))
      .catch((err: any) => console.error(err))
    context.displayPrompt()
  }

  for (const methodName of Object.keys(allRPCMethods)) {
    replServer.defineCommand(methodName, {
      help: `Execute ${methodName}. Example usage: .${methodName} [params].`,
      action(params) {
        defineRPCAction(this, methodName, params)
      },
    })
  }

  replServer.defineCommand('logLevel', {
    help: `Sets the log level.  Example usage: .logLevel info`,
    action(params) {
      const level = params
      if (['debug', 'info', 'warn', 'error'].includes(level)) {
        const log = client.config.logger
        if (!log) {
          this.displayPrompt()
          return
        }
        for (const transport of log.transports) {
          transport.level = level
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(
          'Invalid log level. Valid levels are: debug, info, warn, error.',
        )
      }
      this.displayPrompt()
    },
  })
}

function startRepl(
  client: EthereumClient,
  servers: (RPCServer | http.Server)[],
) {
  const allRPCMethods = servers
    .map((s: any) => s._methods || {})
    .reduce((acc: any, m: any) => Object.assign(acc, m), {})

  const replServer = repl.start({
    prompt: 'EthJS > ',
    ignoreUndefined: true,
  })

  replServer.context.client = client

  replServer.on('exit', async () => {
    console.log('Exiting REPL...')
    await client.stop()
    replServer.close()
    process.exit(0)
  })

  activateRPCMethods(replServer, allRPCMethods, client)
}

// ----------------- Stop client -----------------

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

// ----------------- Main -----------------

async function run() {
  const args = getEnvArgs()

  if (args.helpRPC === true) {
    return helpRPC()
  }

  const { config, customGenesisState, metricsServer } = await generateClientConfig(args)
  logger = config.logger

  const clientStartPromise = startClient(config, args, {
    genesisState: customGenesisState,
  })
    .then((client) => {
      const servers: (RPCServer | http.Server)[] =
        args.rpc === true ||
        args.rpcEngine === true ||
        args.ws === true
          ? startRPCServers(client, {
              rpc: args.rpc ?? true,
              rpcAddr: args.rpcAddr ?? '127.0.0.1',
              rpcPort: args.rpcPort ?? 8545,
              ws: args.ws ?? false,
              wsPort: args.wsPort ?? 8546,
              wsAddr: args.wsAddr ?? '127.0.0.1',
              rpcEngine: args.rpcEngine ?? true,
              rpcEngineAddr: args.rpcEngineAddr ?? '127.0.0.1',
              rpcEnginePort: args.rpcEnginePort ?? 8551,
              wsEngineAddr: args.wsEngineAddr ?? '127.0.0.1',
              wsEnginePort: args.wsEnginePort ?? 8552,
              rpcDebug: args.rpcDebug ?? '',
              rpcDebugVerbose: args.rpcDebugVerbose ?? '',
              helpRPC: args.helpRPC ?? false,
              jwtSecret: args.jwtSecret,
              rpcEngineAuth: args.rpcEngineAuth ?? false,
              rpcCors: args.rpcCors ?? '*',
            })
          : []

      if (
        client.config.chainCommon.gteHardfork(Hardfork.Paris) &&
        (args.rpcEngine === false || args.rpcEngine === undefined)
      ) {
        config.logger?.warn(
          `Engine RPC endpoint not activated on a post-Merge HF setup.`,
        )
      }
      if (metricsServer !== undefined) servers.push(metricsServer)

      startTxBroadcaster(client)

      config.superMsg('Client started successfully')

      if (envBool('ETH_REPL', false)) {
        startRepl(client, servers as RPCServer[])
      }

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
