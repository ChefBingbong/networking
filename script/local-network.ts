#!/usr/bin/env tsx
/**
 * Local Network Script
 * 
 * Spins up 10 EthereumJS client nodes in a local network,
 * simulates transactions between accounts, and mines blocks.
 */

import type { Multiaddr } from '@multiformats/multiaddr'
import { multiaddr } from '@multiformats/multiaddr'
import type { ChainConfig, GenesisState } from '../src/chain-config/index.ts'
import { Common, Hardfork } from '../src/chain-config/index.ts'
import { EthereumClient } from '../src/client/client.ts'
import { Config } from '../src/client/config.ts'
import { createInlineClient } from '../src/client/util/inclineClient.ts'
import { customChainConfig } from '../src/testdata/index.ts'
import { createLegacyTx } from '../src/tx/index.ts'
import {
    Address,
    bytesToHex,
    privateToAddress,
    randomBytes
} from '../src/utils/index.ts'

const NUM_NODES = 5
const BASE_PORT = 30303
const BASE_RPC_PORT = 8545
const MINE_PERIOD = 5 // seconds between mining attempts

// Pre-funded accounts for testing
const ACCOUNTS = Array.from({ length: 20 }, (_, i) => {
  const privateKeyBytes = randomBytes(32)
  // Make it deterministic for testing
  privateKeyBytes[0] = i
  privateKeyBytes[1] = 0
  const addressBytes = privateToAddress(privateKeyBytes)
  return {
    privateKey: privateKeyBytes,
    address: new Address(addressBytes),
  }
})

// Create genesis state with pre-funded accounts
function createGenesisState(): GenesisState {
  const genesisState: GenesisState = {}
  const initialBalance = '0x3635c9adc5dea00000' // 1000 ETH in hex

  for (const account of ACCOUNTS) {
    // Simple format: just balance as hex string
    genesisState[account.address.toString()] = initialBalance
  }

  return genesisState
}

// Clique signer addresses (all nodes will be signers)
const SIGNER_ADDRESSES: Address[] = []

// Initialize signer addresses for all nodes (will be populated when nodes are created)
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

// Create custom chain config for local testing with Clique consensus
function createCustomChainConfig(signerAddresses: Address[]): ChainConfig {
  // Clique extraData format: 32 bytes vanity + signer addresses (20 bytes each) + 65 bytes zeros
  // Build extraData with signer addresses
  let cliqueExtraData = '0x' + '00'.repeat(32) // 32 bytes vanity
  // Add signer addresses (20 bytes each)
  for (const signer of signerAddresses) {
    const addrBytes = signer.bytes
    cliqueExtraData += bytesToHex(addrBytes).slice(2) // Remove 0x prefix and append
  }
  // Add 65 bytes of zeros for signature space
  cliqueExtraData += '00'.repeat(65)
  
  return {
    name: 'local-test',
    chainId: 1337,
    genesis: {
      // Use reasonable values for local testnet
      gasLimit: 8000000, // 8M gas limit
      difficulty: 1, // Clique uses difficulty 1 or 2 (in turn / not in turn)
      timestamp: '0x0000000000000000',
      nonce: '0x0000000000000000' as `0x${string}`,
      extraData: cliqueExtraData as `0x${string}`,
    },
    consensus: {
      type: 'clique',
      algorithm: 'clique',
      clique: {
        period: MINE_PERIOD, // 5 second block time
        epoch: 30000,
      },
    } as const,
    hardforks: [
      { name: 'chainstart', block: 0 },
      { name: 'homestead', block: 0 },
      { name: 'dao', block: 0 },
      { name: 'tangerineWhistle', block: 0 },
      { name: 'spuriousDragon', block: 0 },
      { name: 'byzantium', block: 0 },
      { name: 'constantinople', block: 0 },
      { name: 'petersburg', block: 0 },
      { name: 'istanbul', block: 0 },
      { name: 'muirGlacier', block: 0 },
      { name: 'berlin', block: 0 },
      { name: 'london', block: 0 },
    ],
    bootstrapNodes: [],
  }
}

type NodeInfo = {
  client: EthereumClient
  config: Config
  address: Address
  index: number
}

async function createNode(nodeIndex: number, bootnodes: Multiaddr[] = []): Promise<NodeInfo> {
  // Use signer address for this node (should already be initialized)
  const nodeAddress = SIGNER_ADDRESSES[nodeIndex]
  const nodePrivateKey = randomBytes(32)
  nodePrivateKey[0] = nodeIndex + 100
  nodePrivateKey[1] = 0
  
  // Create chain config with all signer addresses
//   const customChainConfig = createCustomChainConfig(SIGNER_ADDRESSES)
  const common = new Common({ chain: customChainConfig, hardfork: Hardfork.Chainstart })

  const genesisState = createGenesisState()

  // Create config with Clique signer account
  const config = new Config({
    common,
    syncmode: 'full',
    port: BASE_PORT + nodeIndex,
    bootnodes,
    mine: true, // Enable mining
    minerCoinbase: nodeAddress,
    minPeers: 1,
    maxPeers: NUM_NODES - 1,
    isSingleNode: false,
    accountCache: 1000,
    storageCache: 1000,
    codeCache: 1000,
    trieCache: 1000,
    saveReceipts: true,
    key: nodePrivateKey,
    datadir: `./network-data/node-${nodeIndex}`,
    accounts: [[nodeAddress, nodePrivateKey]], // Clique signer account
  })

  // Create client with in-memory databases for testing
  const client = await createInlineClient(
    config,
    common,
    genesisState,
    `./network-data/node-${nodeIndex}`,
    false // Use disk-based DB for persistence (set to true for memory-only)
  )

  return {
    client,
    config,
    address: nodeAddress, // Already an Address
    index: nodeIndex,
  }
}

async function sendRandomTransaction(fromNode: NodeInfo, toAddress: Address) {
  try {
    // Pick a random account to send from
    const fromAccount = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)]
    
    // Get current nonce from state manager
    let nonce = BigInt(0)
    try {
      const account = await fromNode.client.service.execution.vm.stateManager.getAccount(fromAccount.address)
      nonce = account?.nonce ?? BigInt(0)
    } catch (e) {
      // If account doesn't exist, start with nonce 0
      nonce = BigInt(0)
    }
    
    const txData = {
      nonce,
      gasPrice: BigInt('1000000000'), // 1 Gwei
      gasLimit: BigInt('21000'),
      to: toAddress,
      value: BigInt('1000000000000000'), // 0.001 ETH
      data: new Uint8Array(0),
    }

    const tx = createLegacyTx(txData, { common: fromNode.config.chainCommon })
    const signedTx = tx.sign(fromAccount.privateKey)

    // Add to tx pool
    if (fromNode.client.service?.txPool) {
      await fromNode.client.service.txPool.add(signedTx, true)
      console.log(
        `[Node ${fromNode.index}] Sent tx ${bytesToHex(signedTx.hash())} from ${fromAccount.address.toString()} to ${toAddress.toString()} (nonce=${nonce})`
      )
    }
  } catch (error: any) {
    // Silently catch validation errors (like nonce issues) - they're expected during testing
    if (!error.message?.includes('nonce') && !error.message?.includes('balance')) {
      console.error(`[Node ${fromNode.index}] Error sending tx: ${error.message}`)
    }
  }
}

function logNetworkStatus(nodes: NodeInfo[]) {
  console.log('\n=== Network Status ===')
  for (const node of nodes) {
    const chain = node.client.chain
    const height = chain.headers.height
    const latestHash = chain.headers.latest ? bytesToHex(chain.headers.latest.hash()) : 'N/A'
    const peerCount = node.client.service?.pool?.size ?? 0
    
    console.log(
      `Node ${node.index}: Height=${height}, Hash=${latestHash.substring(0, 10)}..., ` +
      `Peers=${peerCount}, Mining=${node.config.mine}`
    )
  }
  console.log('=====================\n')
}

async function main() {
  console.log(`🚀 Starting local network with ${NUM_NODES} nodes...\n`)

  // Initialize signer addresses first (must be done before creating nodes)
  initializeSignerAddresses()
  console.log(`Initialized ${SIGNER_ADDRESSES.length} Clique signers\n`)

  const nodes: NodeInfo[] = []

  // Create first node (will be bootnode)
  console.log('Creating node 0 (bootnode)...')
  const node0 = await createNode(0)
  nodes.push(node0)
  
  // Get bootnode address - start first node and get its info
  await node0.client.start()
  await new Promise((resolve) => setTimeout(resolve, 2000)) // Wait for server to be ready
  
  const bootnodeInfo = node0.client.server()?.getRlpxInfo()
  
  // Create bootnode multiaddr - RLPx uses IP:port format
  const bootnodes: Multiaddr[] = []
  if (bootnodeInfo) {
    const bootnodeAddr = multiaddr(`/ip4/127.0.0.1/tcp/${BASE_PORT}`)
    bootnodes.push(bootnodeAddr)
    console.log(`Bootnode: ${bootnodeInfo.enode}\n`)
  }

  // Create remaining nodes
  for (let i = 1; i < NUM_NODES; i++) {
    console.log(`Creating node ${i}...`)
    const node = await createNode(i, bootnodes.length > 0 ? bootnodes : undefined)
    nodes.push(node)
    await node.client.start()
    await node.client.config.updateSynchronizedState(node.client.chain.headers.latest)
    
    // Small delay to allow connection
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.log(`\n✅ All ${NUM_NODES} nodes created and started!\n`)

  // Wait for network to stabilize
  console.log('Waiting for network to stabilize...')
  await new Promise((resolve) => setTimeout(resolve, 3000))

  // Start transaction simulation
  console.log('📤 Starting transaction simulation...\n')
  
  const txInterval = setInterval(() => {
    // Pick two random nodes
    const fromNode = nodes[Math.floor(Math.random() * nodes.length)]
    const toNode = nodes[Math.floor(Math.random() * nodes.length)]
    
    if (fromNode.index !== toNode.index) {
      const toAddress = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)].address
      sendRandomTransaction(fromNode, toAddress)
    }
  }, 2000) // Send a tx every 2 seconds

  // Log network status periodically
  const statusInterval = setInterval(() => {
    logNetworkStatus(nodes)
  }, 10000) // Every 10 seconds

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down network...')
    
    clearInterval(txInterval)
    clearInterval(statusInterval)
    
    for (const node of nodes) {
      try {
        await node.client.stop()
        console.log(`Node ${node.index} stopped`)
      } catch (error) {
        console.error(`Error stopping node ${node.index}:`, error)
      }
    }
    
    console.log('✅ Network shutdown complete')
    process.exit(0)
  })

  // Keep running
  console.log('Network is running. Press Ctrl+C to stop.\n')
  logNetworkStatus(nodes)

  // Keep process alive
  await new Promise(() => {})
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})

