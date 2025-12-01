#!/usr/bin/env node

/**
 * Script to deploy a smart contract to the test network
 *
 * Usage:
 *   npx tsx src/client/bin/deploy-contract.ts [options]
 *
 * Options:
 *   --rpc <url>       RPC endpoint (default: http://127.0.0.1:8545)
 *   --account <index> Account index to use from accounts.json (default: 0)
 *   --bytecode <hex>  Contract bytecode to deploy (or uses default SimpleStorage)
 */

import { existsSync, readFileSync } from "fs";
import { Common } from "../../chain-config/index.ts";
import { createLegacyTx } from "../../tx/index.ts";
import {
	bytesToHex,
	createAddressFromPrivateKey,
	hexToBytes,
} from "../../utils/index.ts";

// Import the custom chain config from test-network
import { customChainConfig } from "./test-network.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ACCOUNTS_FILE = "./test-network-data/accounts.json";
const DEFAULT_RPC = "http://127.0.0.1:8545";

// Simple Storage Contract Bytecode
// This is a minimal contract that stores and retrieves a uint256
//
// pragma solidity ^0.8.0;
// contract SimpleStorage {
//     uint256 public storedData;
//
//     constructor(uint256 initialValue) {
//         storedData = initialValue;
//     }
//
//     function set(uint256 x) public {
//         storedData = x;
//     }
//
//     function get() public view returns (uint256) {
//         return storedData;
//     }
// }
const SIMPLE_STORAGE_BYTECODE =
	"0x608060405234801561001057600080fd5b5060405161012038038061012083398101604081905261002f91610037565b600055610050565b60006020828403121561004957600080fd5b5051919050565b60c28061005e6000396000f3fe6080604052348015600f57600080fd5b5060043610603c5760003560e01c80632a1afcd914604157806360fe47b114605b5780636d4ce63c146069575b600080fd5b604960005481565b60405190815260200160405180910390f35b606760663660046074565b600055565b005b60005460405190815260200160405180910390f35b600060208284031215608557600080fd5b503591905056fea264697066735822122000000000000000000000000000000000000000000000000000000000000000000064736f6c63430008130033";

// Constructor argument: initial value = 42 (0x2a)
const CONSTRUCTOR_ARG =
	"000000000000000000000000000000000000000000000000000000000000002a";

// ============================================================================
// TYPES
// ============================================================================

interface AccountInfo {
	index: number;
	address: string;
	privateKey: string;
	role: string;
}

interface RPCResponse {
	jsonrpc: string;
	id: number;
	result?: any;
	error?: { code: number; message: string };
}

// ============================================================================
// RPC HELPERS
// ============================================================================

async function rpcCall(
	url: string,
	method: string,
	params: any[] = [],
): Promise<any> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method,
			params,
			id: Date.now(),
		}),
	});

	const json = (await response.json()) as RPCResponse;

	if (json.error) {
		throw new Error(
			`RPC Error: ${json.error.message} (code: ${json.error.code})`,
		);
	}

	return json.result;
}

async function getTransactionCount(
	rpc: string,
	address: string,
): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_getTransactionCount", [
		address,
		"latest",
	]);
	return BigInt(result);
}

async function getGasPrice(rpc: string): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_gasPrice", []);
	return BigInt(result);
}

async function getChainId(rpc: string): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_chainId", []);
	return BigInt(result);
}

async function estimateGas(rpc: string, tx: object): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_estimateGas", [tx]);
	return BigInt(result);
}

async function sendRawTransaction(
	rpc: string,
	signedTx: string,
): Promise<string> {
	return await rpcCall(rpc, "eth_sendRawTransaction", [signedTx]);
}

async function getTransactionReceipt(
	rpc: string,
	txHash: string,
): Promise<any> {
	return await rpcCall(rpc, "eth_getTransactionReceipt", [txHash]);
}

async function getBalance(rpc: string, address: string): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_getBalance", [address, "latest"]);
	return BigInt(result);
}

// ============================================================================
// MAIN DEPLOY FUNCTION
// ============================================================================

async function deployContract(options: {
	rpc: string;
	accountIndex: number;
	bytecode: string;
}) {
	const { rpc, accountIndex, bytecode } = options;

	console.log("\n" + "=".repeat(60));
	console.log("🚀 Contract Deployment Script");
	console.log("=".repeat(60));

	// Load accounts
	if (!existsSync(ACCOUNTS_FILE)) {
		throw new Error(
			`Accounts file not found: ${ACCOUNTS_FILE}\n` +
				"Make sure to start the bootnode first with CLEAN=true",
		);
	}

	const accounts: AccountInfo[] = JSON.parse(
		readFileSync(ACCOUNTS_FILE, "utf-8"),
	);
	const account = accounts[accountIndex];

	if (!account) {
		throw new Error(
			`Account index ${accountIndex} not found. Available: 0-${accounts.length - 1}`,
		);
	}

	console.log(`\n📋 Configuration:`);
	console.log(`   RPC:      ${rpc}`);
	console.log(`   Account:  ${account.address} (index ${accountIndex})`);
	console.log(`   Role:     ${account.role}`);

	// Check connection
	console.log(`\n🔗 Connecting to RPC...`);
	const chainId = await getChainId(rpc);
	console.log(`   Chain ID: ${chainId}`);

	// Check balance
	const balance = await getBalance(rpc, account.address);
	const balanceEth = Number(balance) / 1e18;
	console.log(`   Balance:  ${balanceEth.toFixed(4)} ETH`);

	if (balance === 0n) {
		throw new Error(
			"Account has no ETH. Make sure genesis state includes this account.",
		);
	}

	// Get nonce
	const nonce = await getTransactionCount(rpc, account.address);
	console.log(`   Nonce:    ${nonce}`);

	// Get gas price (use minimum 1 gwei if returned 0)
	let gasPrice = await getGasPrice(rpc);
	if (gasPrice === 0n) {
		gasPrice = 1000000000n; // 1 gwei minimum
	}
	console.log(`   Gas Price: ${gasPrice} wei`);

	// Prepare deployment data
	const deployData = bytecode + CONSTRUCTOR_ARG;
	console.log(
		`\n📦 Contract bytecode: ${bytecode.slice(0, 20)}...${bytecode.slice(-20)}`,
	);
	console.log(`   Bytecode size: ${(bytecode.length - 2) / 2} bytes`);

	// Estimate gas
	console.log(`\n⛽ Estimating gas...`);
	const estimatedGas = await estimateGas(rpc, {
		from: account.address,
		data: deployData,
	});
	const gasLimit = (estimatedGas * 120n) / 100n; // Add 20% buffer
	console.log(`   Estimated: ${estimatedGas}`);
	console.log(`   Gas Limit: ${gasLimit} (with 20% buffer)`);

	// Create transaction with proper chain ID
	console.log(`\n📝 Creating transaction...`);
	const privateKey = hexToBytes(account.privateKey as `0x${string}`);

	// Create Common with our chain config for proper EIP-155 signing
	const common = new Common({ chain: customChainConfig });

	const tx = createLegacyTx(
		{
			nonce,
			gasPrice,
			gasLimit,
			to: undefined, // Contract creation
			value: 0n,
			data: hexToBytes(deployData as `0x${string}`),
		},
		{ common },
	);

	// Sign transaction
	const signedTx = tx.sign(privateKey);
	const serializedTx = bytesToHex(signedTx.serialize());

	// Show sender address
	const senderAddress = createAddressFromPrivateKey(privateKey);
	console.log(`   From: ${senderAddress}`);
	console.log(`   Nonce: ${nonce}`);
	console.log(`   Gas Limit: ${gasLimit}`);
	console.log(`   Gas Price: ${gasPrice} wei`);

	// Send transaction
	console.log(`\n📤 Sending transaction...`);
	const txHash = await sendRawTransaction(rpc, serializedTx);
	console.log(`   Tx Hash: ${txHash}`);

	// Wait for receipt
	console.log(`\n⏳ Waiting for confirmation...`);
	let receipt = null;
	let attempts = 0;
	const maxAttempts = 60; // 60 seconds max

	while (!receipt && attempts < maxAttempts) {
		await new Promise((r) => setTimeout(r, 1000));
		receipt = await getTransactionReceipt(rpc, txHash);
		attempts++;
		if (attempts % 5 === 0) {
			console.log(`   Still waiting... (${attempts}s)`);
		}
	}

	if (!receipt) {
		console.log(`\n⚠️  Transaction not yet confirmed after ${maxAttempts}s`);
		console.log(`   Check later with: eth_getTransactionReceipt("${txHash}")`);
		return;
	}

	// Success!
	console.log(`\n` + "=".repeat(60));
	console.log(`✅ CONTRACT DEPLOYED!`);
	console.log("=".repeat(60));
	console.log(`   Contract Address: ${receipt.contractAddress}`);
	console.log(`   Transaction Hash: ${txHash}`);
	console.log(`   Block Number:     ${parseInt(receipt.blockNumber, 16)}`);
	console.log(`   Gas Used:         ${parseInt(receipt.gasUsed, 16)}`);
	console.log(
		`   Status:           ${receipt.status === "0x1" ? "Success ✓" : "Failed ✗"}`,
	);
	console.log("=".repeat(60) + "\n");

	// Show how to interact
	console.log(`📖 How to interact with your contract:\n`);
	console.log(`# Get stored value (call get() function):`);
	console.log(`curl -X POST -H "Content-Type: application/json" \\`);
	console.log(
		`  --data '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"${receipt.contractAddress}","data":"0x6d4ce63c"},"latest"],"id":1}' \\`,
	);
	console.log(`  ${rpc}\n`);

	console.log(`# Set new value (send set(100) transaction):`);
	console.log(
		`# You'll need to sign and send a transaction with data: 0x60fe47b1 + value`,
	);
	console.log(
		`# e.g., set(100) = 0x60fe47b10000000000000000000000000000000000000000000000000000000000000064\n`,
	);

	return receipt;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
	// Parse arguments
	// const args = process.argv.slice(2);
	let rpc = DEFAULT_RPC;
	let accountIndex = 1;
	let bytecode = SIMPLE_STORAGE_BYTECODE;

	// 	for (let i = 0; i < args.length; i++) {
	// 		switch (args[i]) {
	// 			case "--rpc":
	// 				rpc = args[++i];
	// 				break;
	// 			case "--account":
	// 				accountIndex = parseInt(args[++i], 10);
	// 				break;
	// 			case "--bytecode":
	// 				bytecode = args[++i];
	// 				break;
	// 			case "--help":
	// 				console.log(`
	// Usage: npx tsx src/client/bin/deploy-contract.ts [options]

	// Options:
	//   --rpc <url>       RPC endpoint (default: ${DEFAULT_RPC})
	//   --account <index> Account index from accounts.json (default: 0)
	//   --bytecode <hex>  Contract bytecode (default: SimpleStorage)

	// Example:
	//   npx tsx src/client/bin/deploy-contract.ts --rpc http://127.0.0.1:8545 --account 0
	// `);
	// 				process.exit(0);
	// 		}
	// 	}

	try {
		await deployContract({ rpc, accountIndex, bytecode });
	} catch (error: any) {
		console.error(`\n❌ Error: ${error.message}\n`);
		process.exit(1);
	}
}

main();
