// envArgs.ts
import { homedir } from 'os'
import path from 'path'
import { Config, SyncMode } from '../config.ts'
import type { ClientOpts } from '../types.ts'

const boolEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const v = raw.toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

const numEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isNaN(n) ? fallback : n
}

const strEnv = (name: string, fallback: string): string => {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

/**
 * Build ClientOpts purely from ENV (ETH_* variables).
 *
 * Defaults:
 *  - single-node PoA devnet (ETH_DEV=poa)
 *  - mining enabled (ETH_MINE=true)
 *  - RPC HTTP on 127.0.0.1:8545
 *  - datadir: ~/.ethjs-dev
 */
export function getEnvArgs(): ClientOpts {
  const dataDirDefault = `${homedir()}/.ethjs-dev`

  // Map ETH_DEV to the existing "dev" option semantics.
  // Valid: 'false' | 'true' | 'poa' | 'pow'
  const devEnv = process.env.ETH_DEV?.toLowerCase()
  let dev: ClientOpts['dev'] | undefined = 'poa' // default: dev PoA

  if (devEnv === 'false') dev = 'false'
  else if (devEnv === 'true') dev = 'true'
  else if (devEnv === 'poa') dev = 'poa'
  else if (devEnv === 'pow') dev = 'pow'
  else if (devEnv === undefined) dev = 'poa'

  const args: ClientOpts = {
    //
    // Chain/network
    //
    network: (process.env.ETH_NETWORK ?? 'mainnet').toLowerCase() as any,
    chainId: process.env.ETH_CHAIN_ID ? Number(process.env.ETH_CHAIN_ID) : undefined,
    networkId: undefined,
    sync: ((process.env.ETH_SYNC as SyncMode) ?? Config.SYNCMODE_DEFAULT) as SyncMode,

    //
    // Data dirs / chain files
    //
    dataDir: strEnv('ETH_DATADIR', dataDirDefault),
    customChain: process.env.ETH_CUSTOM_CHAIN
      ? path.resolve(process.env.ETH_CUSTOM_CHAIN)
      : undefined,
    customGenesisState: process.env.ETH_CUSTOM_GENESIS_STATE
      ? path.resolve(process.env.ETH_CUSTOM_GENESIS_STATE)
      : undefined,
    gethGenesis: process.env.ETH_GETH_GENESIS
      ? path.resolve(process.env.ETH_GETH_GENESIS)
      : undefined,
    trustedSetup: process.env.ETH_TRUSTED_SETUP
      ? path.resolve(process.env.ETH_TRUSTED_SETUP)
      : undefined,

    //
    // P2P / discovery
    //
    bootnodes: process.env.ETH_BOOTNODES
      ? process.env.ETH_BOOTNODES.split(',').filter(Boolean)
      : undefined,
    port: numEnv('ETH_PORT', Config.PORT_DEFAULT),
    extIP: process.env.ETH_EXT_IP,
    multiaddrs: process.env.ETH_MULTIADDRS
      ? process.env.ETH_MULTIADDRS.split(',').filter(Boolean)
      : undefined,

    //
    // RPC / Engine / WS
    //
    rpc: boolEnv('ETH_RPC', true),
    rpcPort: numEnv('ETH_RPC_PORT', 8545),
    rpcAddr: strEnv('ETH_RPC_ADDR', '127.0.0.1'),

    ws: boolEnv('ETH_WS', false),
    wsPort: numEnv('ETH_WS_PORT', 8546),
    wsAddr: strEnv('ETH_WS_ADDR', '127.0.0.1'),

    rpcEngine: boolEnv('ETH_ENGINE', false),
    rpcEnginePort: numEnv('ETH_ENGINE_PORT', 8551),
    rpcEngineAddr: strEnv('ETH_ENGINE_ADDR', '127.0.0.1'),
    wsEnginePort: numEnv('ETH_WS_ENGINE_PORT', 8552),
    wsEngineAddr: strEnv('ETH_WS_ENGINE_ADDR', '127.0.0.1'),

    rpcEngineAuth: boolEnv('ETH_ENGINE_AUTH', true),
    jwtSecret: process.env.ETH_JWT_SECRET
      ? path.resolve(process.env.ETH_JWT_SECRET)
      : undefined,

    helpRPC: boolEnv('ETH_HELP_RPC', false),
    rpcDebug: strEnv('ETH_RPC_DEBUG', ''),
    rpcDebugVerbose: strEnv('ETH_RPC_DEBUG_VERBOSE', ''),
    rpcCors: strEnv('ETH_RPC_CORS', '*'),

    //
    // Logging
    //
    logLevel: (process.env.ETH_LOG_LEVEL as any) ?? 'info',
    logFile:
      process.env.ETH_LOG_FILE === 'false'
        ? false
        : process.env.ETH_LOG_FILE === undefined || process.env.ETH_LOG_FILE === ''
        ? true
        : process.env.ETH_LOG_FILE,
    logLevelFile: (process.env.ETH_LOG_LEVEL_FILE as any) ?? 'debug',
    logRotate: boolEnv('ETH_LOG_ROTATE', true),
    logMaxFiles: numEnv('ETH_LOG_MAX_FILES', 5),

    //
    // Metrics
    //
    prometheus: boolEnv('ETH_PROMETHEUS', false),
    prometheusPort: numEnv('ETH_PROMETHEUS_PORT', 8000),

    //
    // Sync / performance knobs
    //
    maxPerRequest: numEnv('ETH_MAX_PER_REQUEST', Config.MAXPERREQUEST_DEFAULT),
    maxFetcherJobs: numEnv('ETH_MAX_FETCHER_JOBS', Config.MAXFETCHERJOBS_DEFAULT),
    minPeers: numEnv('ETH_MIN_PEERS', Config.MINPEERS_DEFAULT),
    maxPeers: numEnv('ETH_MAX_PEERS', Config.MAXPEERS_DEFAULT),
    dnsAddr: strEnv('ETH_DNS_ADDR', Config.DNSADDR_DEFAULT),
    dnsNetworks: process.env.ETH_DNS_NETWORKS
      ? process.env.ETH_DNS_NETWORKS.split(',').filter(Boolean)
      : undefined,

    execution: boolEnv('ETH_EXECUTION', Config.EXECUTION),
    numBlocksPerIteration: numEnv(
      'ETH_NUM_BLOCKS_PER_ITERATION',
      Config.NUM_BLOCKS_PER_ITERATION,
    ),

    accountCache: numEnv('ETH_ACCOUNT_CACHE', Config.ACCOUNT_CACHE),
    storageCache: numEnv('ETH_STORAGE_CACHE', Config.STORAGE_CACHE),
    codeCache: numEnv('ETH_CODE_CACHE', Config.CODE_CACHE),
    trieCache: numEnv('ETH_TRIE_CACHE', Config.TRIE_CACHE),

    debugCode: boolEnv('ETH_DEBUG_CODE', Config.DEBUGCODE_DEFAULT),

    discDns: boolEnv('ETH_DISC_DNS', false),
    discV4: boolEnv('ETH_DISC_V4', false),

    //
    // Dev / mining / accounts
    //
    dev,
    mine: boolEnv('ETH_MINE', true),
    unlock: process.env.ETH_UNLOCK,
    minerCoinbase: undefined, // could wire ETH_MINER_COINBASE if you like
    saveReceipts: boolEnv('ETH_SAVE_RECEIPTS', true),

    //
    // State sync / trie behaviour
    //
    snap: boolEnv('ETH_SNAP', false),
    prefixStorageTrieKeys: boolEnv('ETH_PREFIX_STORAGE_TRIE_KEYS', true),
    useStringValueTrieDB: boolEnv('ETH_USE_STRING_TRIE_DB', false),
    txLookupLimit: numEnv('ETH_TX_LOOKUP_LIMIT', 2350000),

    startBlock: process.env.ETH_START_BLOCK
      ? Number(process.env.ETH_START_BLOCK)
      : undefined,
    startExecution: boolEnv('ETH_START_EXECUTION', false),
    isSingleNode: boolEnv('ETH_SINGLE_NODE', true),

    vmProfileBlocks: boolEnv('ETH_VM_PROFILE_BLOCKS', false),
    vmProfileTxs: boolEnv('ETH_VM_PROFILE_TXS', false),

    loadBlocksFromRlp: process.env.ETH_LOAD_BLOCKS_FROM_RLP
      ? process.env.ETH_LOAD_BLOCKS_FROM_RLP.split(',').filter(Boolean)
      : undefined,

    pruneEngineCache: boolEnv('ETH_PRUNE_ENGINE_CACHE', true),
    engineNewpayloadMaxExecute: process.env.ETH_ENGINE_NEWPAYLOAD_MAX_EXECUTE
      ? Number(process.env.ETH_ENGINE_NEWPAYLOAD_MAX_EXECUTE)
      : undefined,
    skipEngineExec: boolEnv('ETH_SKIP_ENGINE_EXEC', false),

    useJsCrypto: boolEnv('ETH_USE_JS_CRYPTO', false),
  }

  return args
}
