#!/usr/bin/env ts-node

import { readFileSync } from 'fs'
import { createWalletClient, defineChain, Hex, http, parseEther, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ---- ENV CONFIG ----

// RPC endpoint of your miner node
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545'

// Address to receive funds (0x-prefixed)
const TO_ADDRESS = process.env.TO_ADDRESS as Hex | undefined

// Amount in ETH (string, e.g. "1.0")
const AMOUNT_ETH = process.env.AMOUNT_ETH || '0.1'

// Chain ID (must match your devnet / ETH_DEV chainId)
const CHAIN_ID = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 123456

// Miner private key: either directly in env or from same file as ETH_UNLOCK
const MINER_PRIVATE_KEY = process.env.MINER_PRIVATE_KEY
const MINER_KEY_FILE = process.env.MINER_KEY_FILE // path to file containing hex without 0x

if (!TO_ADDRESS) {
  console.error('Missing TO_ADDRESS env var (0x-prefixed target address).')
  process.exit(1)
}

function loadPrivateKey(): Hex {
  if (MINER_PRIVATE_KEY) {
    return MINER_PRIVATE_KEY.startsWith('0x')
      ? (MINER_PRIVATE_KEY as Hex)
      : (`0x${MINER_PRIVATE_KEY}` as Hex)
  }

  if (MINER_KEY_FILE) {
    const raw = readFileSync(MINER_KEY_FILE, 'utf8').trim()
    const hexNo0x = raw.startsWith('0x') ? raw.slice(2) : raw
    if (hexNo0x.length !== 64) {
      console.error(
        `MINER_KEY_FILE does not contain a 32-byte hex key (found length=${hexNo0x.length}).`,
      )
      process.exit(1)
    }
    return (`0x${hexNo0x}` as Hex)
  }

  console.error(
    'You must set MINER_PRIVATE_KEY=0x... or MINER_KEY_FILE=/path/to/key to sign the tx.',
  )
  process.exit(1)
}

// Define your devnet chain (chainId MUST match your client)
const devnet = defineChain({
  id: CHAIN_ID,
  name: 'local-devnet',
  network: 'local-devnet',
  nativeCurrency: {
    name: 'TestETH',
    symbol: 'TETH',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
})

async function main() {
  const privateKey = loadPrivateKey()
  const account = privateKeyToAccount(privateKey)

  console.log('Using miner account:', account.address)
  console.log('Sending to          :', TO_ADDRESS)
  console.log('Amount (ETH)       :', AMOUNT_ETH)
  console.log('RPC URL            :', RPC_URL)
  console.log('Chain ID           :', CHAIN_ID)

  const client = createWalletClient({
    account,
    chain: devnet,
    transport: http(RPC_URL),
  }).extend(publicActions)

  const value = parseEther(AMOUNT_ETH)

  // Build & send tx
  const hash = await client.sendTransaction({
    account,
    to: TO_ADDRESS,
    value,
    gasPrice: 900000000,
    gas: 4700000,

  })

  console.log('Sent tx, hash =', hash)

  // Optional: wait for confirmation
  if (process.env.WAIT_FOR_RECEIPT === 'true') {
    console.log('Waiting for receipt...')
    const receipt = await client.waitForTransactionReceipt({ hash })
    console.log('Tx mined in block:', receipt.blockNumber)
    console.log('Status           :', receipt.status)
  }
}

main().catch((err) => {
  console.error('Error sending test funds:', err)
  process.exit(1)
})
