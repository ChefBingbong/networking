#!/usr/bin/env node

/**
 * Script to interact with a deployed SimpleStorage contract
 *
 * Usage:
 *   npx tsx src/client/bin/interact-contract.ts <command> [options]
 *
 * Commands:
 *   get              Get the stored value
 *   set <value>      Set a new value
 *   balance [addr]   Get account balance
 *
 * Options:
 *   --rpc <url>      RPC endpoint (default: http://127.0.0.1:8545)
 *   --contract <addr> Contract address
 *   --account <index> Account index for signing (default: 0)
 */

import { existsSync, readFileSync } from "fs";
import { Common } from "../../chain-config/index.ts";
import { createLegacyTx } from "../../tx/index.ts";
import { bytesToHex, hexToBytes } from "../../utils/index.ts";

// Import the custom chain config from test-network
import { customChainConfig } from "./test-network.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ACCOUNTS_FILE = "./test-network-data/accounts.json";
const DEFAULT_RPC = "http://127.0.0.1:8545";

// Function selectors for SimpleStorage
const FUNCTION_SELECTORS = {
	get: "0x6d4ce63c", // get()
	set: "0x60fe47b1", // set(uint256)
	storedData: "0x2a1afcd9", // storedData()
};

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

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
	return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
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

async function getBlockNumber(rpc: string): Promise<bigint> {
	const result = await rpcCall(rpc, "eth_blockNumber", []);
	return BigInt(result);
}

// ============================================================================
// CONTRACT INTERACTION
// ============================================================================

function loadAccounts(): AccountInfo[] {
	if (!existsSync(ACCOUNTS_FILE)) {
		throw new Error(
			`Accounts file not found: ${ACCOUNTS_FILE}\n` +
				"Make sure to start the bootnode first with CLEAN=true",
		);
	}
	return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
}

async function getCode(rpc: string, address: string): Promise<string> {
	const result = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
	return result;
}

async function verifyContract(
	rpc: string,
	contractAddress: string,
): Promise<void> {
	const code = await getCode(rpc, contractAddress);
	if (code === "0x" || code === "" || !code) {
		throw new Error(
			`No contract found at ${contractAddress}\n` +
				"Make sure to deploy the contract first with:\n" +
				"  npx tsx src/client/bin/deploy-contract.ts",
		);
	}
	console.log(
		`   Contract code: ${code.slice(0, 20)}... (${(code.length - 2) / 2} bytes)`,
	);
}

async function getValue(rpc: string, contractAddress: string): Promise<bigint> {
	const result = await ethCall(rpc, contractAddress, FUNCTION_SELECTORS.get);
	return BigInt(result);
}

async function setValue(
	rpc: string,
	contractAddress: string,
	value: bigint,
	account: AccountInfo,
): Promise<string> {
	const privateKey = hexToBytes(account.privateKey as `0x${string}`);

	// Encode the set(uint256) call
	const valueHex = value.toString(16).padStart(64, "0");
	const data = FUNCTION_SELECTORS.set + valueHex;

	// Get transaction parameters
	const nonce = await getTransactionCount(rpc, account.address);
	let gasPrice = await getGasPrice(rpc);
	if (gasPrice === 0n) {
		gasPrice = 1000000000n; // 1 gwei minimum
	}

	// Estimate gas with a sanity check
	const estimatedGas = await estimateGas(rpc, {
		from: account.address,
		to: contractAddress,
		data,
	});

	// If estimated gas is suspiciously high, the call would likely fail
	// SimpleStorage.set() should only need ~50k gas
	// if (estimatedGas > 500000n) {
	// 	console.error(
	// 		`⚠️  Warning: Gas estimate is very high (${estimatedGas}). This usually means the call would fail.`,
	// 	);
	// 	console.error(`   Check that the contract exists at ${contractAddress}`);
	// 	throw new Error(
	// 		`Gas estimate too high - contract may not exist or call would revert`,
	// 	);
	// }

	// Add 20% buffer
	const gasLimit = estimatedGas;

	// Create and sign transaction with proper chain ID
	const common = new Common({ chain: customChainConfig });

	const tx = createLegacyTx(
		{
			nonce,
			gasPrice,
			gasLimit,
			to: hexToBytes(contractAddress as `0x${string}`),
			value: 0n,
			data: hexToBytes(data as `0x${string}`),
		},
		{ common },
	);

	const signedTx = tx.sign(privateKey);
	const serializedTx = bytesToHex(signedTx.serialize());

	// Send transaction
	const txHash = await sendRawTransaction(rpc, serializedTx);
	return txHash;
}

// ============================================================================
// COMMANDS
// ============================================================================

async function cmdGet(rpc: string, contractAddress: string) {
	console.log(`\n📖 Reading value from contract ${contractAddress}...`);
	await verifyContract(rpc, contractAddress);
	const value = await getValue(rpc, contractAddress);
	console.log(`   Stored Value: ${value}\n`);
	return value;
}

async function cmdSet(
	rpc: string,
	contractAddress: string,
	value: bigint,
	accountIndex: number,
) {
	const accounts = loadAccounts();
	const account = accounts[accountIndex];

	if (!account) {
		throw new Error(`Account index ${accountIndex} not found`);
	}

	console.log(`\n✏️  Setting value to ${value}...`);
	console.log(`   Contract: ${contractAddress}`);
	console.log(`   From:     ${account.address}`);

	// Verify contract exists
	await verifyContract(rpc, contractAddress);

	const txHash = await setValue(rpc, contractAddress, value, account);
	console.log(`   Tx Hash:  ${txHash}`);

	// Wait for confirmation
	console.log(`\n⏳ Waiting for confirmation...`);
	let receipt = null;
	let attempts = 0;

	while (!receipt && attempts < 60) {
		await new Promise((r) => setTimeout(r, 1000));
		receipt = await getTransactionReceipt(rpc, txHash);
		attempts++;
	}

	if (receipt) {
		console.log(
			`   Status:   ${receipt.status === "0x1" ? "Success ✓" : "Failed ✗"}`,
		);
		console.log(`   Block:    ${parseInt(receipt.blockNumber, 16)}`);
		console.log(`   Gas Used: ${parseInt(receipt.gasUsed, 16)}\n`);
	} else {
		console.log(`   ⚠️  Not confirmed yet\n`);
	}
}

async function cmdBalance(
	rpc: string,
	address?: string,
	accountIndex?: number,
) {
	let targetAddress = address;

	if (!targetAddress) {
		const accounts = loadAccounts();
		const idx = accountIndex ?? 0;
		targetAddress = accounts[idx]?.address;
		if (!targetAddress) {
			throw new Error(`Account index ${idx} not found`);
		}
	}

	console.log(`\n💰 Getting balance for ${targetAddress}...`);
	const balance = await getBalance(rpc, targetAddress);
	const balanceEth = Number(balance) / 1e18;
	console.log(`   Balance: ${balanceEth.toFixed(6)} ETH`);
	console.log(`   Wei:     ${balance}\n`);
}

async function cmdStatus(rpc: string) {
	console.log(`\n📊 Network Status`);
	console.log(`   RPC:         ${rpc}`);

	try {
		const blockNumber = await getBlockNumber(rpc);
		console.log(`   Block:       ${blockNumber}`);

		const chainId = await rpcCall(rpc, "eth_chainId", []);
		console.log(`   Chain ID:    ${BigInt(chainId)}`);

		const gasPrice = await getGasPrice(rpc);
		console.log(`   Gas Price:   ${gasPrice} wei`);

		const accounts = loadAccounts();
		console.log(`\n   Accounts:`);
		for (const acc of accounts) {
			const balance = await getBalance(rpc, acc.address);
			const balanceEth = Number(balance) / 1e18;
			console.log(
				`   [${acc.index}] ${acc.address.slice(0, 10)}... - ${balanceEth.toFixed(4)} ETH (${acc.role})`,
			);
		}
	} catch (e: any) {
		console.log(`   Error: ${e.message}`);
	}
	console.log();
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
	const args = process.argv.slice(2);
	let rpc = DEFAULT_RPC;
	let contractAddress = "";
	let accountIndex = 0;

	// Parse options first
	const positionalArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--rpc":
				rpc = args[++i];
				break;
			case "--contract":
				contractAddress = args[++i];
				break;
			case "--account":
				accountIndex = parseInt(args[++i], 10);
				break;
			case "--help":
				printHelp();
				process.exit(0);
				break;
			default:
				if (!args[i].startsWith("--")) {
					positionalArgs.push(args[i]);
				}
		}
	}

	const command = positionalArgs[0];

	if (!command) {
		printHelp();
		process.exit(1);
	}

	try {
		switch (command) {
			case "get":
				if (!contractAddress) {
					throw new Error("--contract <address> is required");
				}
				await cmdGet(rpc, contractAddress);
				break;

			case "set": {
				if (!contractAddress) {
					throw new Error("--contract <address> is required");
				}
				const value = BigInt(positionalArgs[1] ?? 0);
				await cmdSet(rpc, contractAddress, value, accountIndex);
				break;
			}

			case "balance":
				await cmdBalance(rpc, positionalArgs[1], accountIndex);
				break;

			case "status":
				await cmdStatus(rpc);
				break;

			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	} catch (error: any) {
		console.error(`\n❌ Error: ${error.message}\n`);
		process.exit(1);
	}
}

function printHelp() {
	console.log(`
Usage: npx tsx src/client/bin/interact-contract.ts <command> [options]

Commands:
  get                 Get the stored value from contract
  set <value>         Set a new value in the contract
  balance [address]   Get account balance
  status              Show network and account status

Options:
  --rpc <url>         RPC endpoint (default: ${DEFAULT_RPC})
  --contract <addr>   Contract address (required for get/set)
  --account <index>   Account index from accounts.json (default: 0)

Examples:
  # Check network status
  npx tsx src/client/bin/interact-contract.ts status

  # Get stored value
  npx tsx src/client/bin/interact-contract.ts get --contract 0x...

  # Set new value
  npx tsx src/client/bin/interact-contract.ts set 100 --contract 0x...

  # Check balance
  npx tsx src/client/bin/interact-contract.ts balance --account 0
`);
}

main();
