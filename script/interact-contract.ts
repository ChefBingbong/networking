// script/interact-contract.ts
// Example script showing how to interact with a deployed contract

import {
	addressFromPrivateKey,
	clientGetBalance,
	clientMineBlock,
	clientSendTransaction,
	clientStart,
	createBlockchainClient,
	createTransaction,
	readStorageValue,
	signTransaction,
} from "../src/blockchain";
import { getAccount, putAccount } from "../src/blockchain/state/state-manager";
import {
	calculateContractAddress,
	createStorageContractDeploymentData,
} from "../src/blockchain/utils/contracts";
import { createNode } from "../src/node/createNode";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000;

async function main() {
	console.log("=== Contract Interaction Demo ===\n");

	// Create a single node
	const node = await createNode({
		host: HOST,
		port: BASE_PORT,
		start: false,
		nodeTypes: "peer",
	});

	await node.start();

	// Create blockchain client
	const keyPair = generateSecp256k1KeyPrivPubPair();
	const privateKeyBytes = keyPair.privateKey.raw;
	const minerAddress = addressFromPrivateKey(privateKeyBytes);

	const client = createBlockchainClient(node, "local", undefined, minerAddress);
	await clientStart(client);

	console.log(`Node created: ${node.address.toString()}`);
	console.log(`Miner address: ${minerAddress}\n`);

	// Wait for network to bootstrap
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Mine genesis block
	console.log("1. Mining genesis block...");
	const genesisBlock = clientMineBlock(client);
	if (genesisBlock) {
		console.log(`   ✓ Genesis block mined\n`);
	}

	// Create deployer account
	const deployerKey = generateSecp256k1KeyPrivPubPair();
	const deployerAddress = addressFromPrivateKey(deployerKey.privateKey.raw);

	// Give deployer some balance
	const deployerAccount = getAccount(client.stateManager, deployerAddress);
	deployerAccount.balance = 5000000000000000000n; // 5 ETH
	putAccount(client.stateManager, deployerAddress, deployerAccount);
	console.log(`2. Allocated 5 ETH to deployer: ${deployerAddress}\n`);

	// Deploy contract
	console.log("3. Deploying SimpleStorage contract...");
	const initialValue = 100n;
	const contractBytecode = createStorageContractDeploymentData(initialValue);

	const deployTx = createTransaction({
		type: "legacy",
		nonce: 0n,
		gasPrice: 1000000000n,
		gasLimit: 1000000n,
		to: undefined,
		value: 0n,
		data: contractBytecode,
		chainId: client.config.chainId,
	});

	const signedDeployTx = signTransaction(deployTx, deployerKey.privateKey.raw);
	clientSendTransaction(client, signedDeployTx);
	await new Promise((resolve) => setTimeout(resolve, 2000));

	const deployBlock = clientMineBlock(client);
	if (!deployBlock) {
		throw new Error("Failed to mine deployment block");
	}

	// Get contract address
	const deployerAccountAfter = getAccount(client.stateManager, deployerAddress);
	const contractNonce = deployerAccountAfter.nonce - 1n;
	const contractAddress = calculateContractAddress(
		deployerAddress,
		contractNonce,
	);

	console.log(`   ✓ Contract deployed at: ${contractAddress}\n`);

	// ==========================================
	// INTERACTING WITH THE CONTRACT
	// ==========================================

	console.log("=== Contract Interactions ===\n");

	// Method 1: Read contract state (read-only call)
	console.log("4. Reading contract value (read-only call)...");
	try {
		const storedValue = readStorageValue(
			client,
			contractAddress as any,
			deployerAddress,
		);
		console.log(`   ✓ Stored value: ${storedValue.toString()}\n`);
	} catch (error) {
		console.log(`   ✗ Error reading value: ${error}\n`);
	}

	// Method 2: Call contract function directly (read-only)
	console.log("5. Calling contract get() function directly...");
	const { clientCall, createGetValueCallData, decodeUint256ReturnData } =
		await import("../src/blockchain");
	const getCallData = createGetValueCallData();
	const returnData = clientCall(
		client,
		contractAddress as any,
		getCallData,
		deployerAddress,
		0n,
	);
	const value = decodeUint256ReturnData(returnData);
	console.log(`   ✓ Returned value: ${value.toString()}\n`);

	// Method 3: Send transaction to contract (state-changing)
	// Note: Our simple contract doesn't have a setter, but this shows how you would do it
	console.log("6. Example: Sending transaction to contract...");
	console.log("   (Note: SimpleStorage contract only has a getter)");
	console.log("   To update storage, you would:");
	console.log("   1. Create transaction with call data");
	console.log("   2. Sign the transaction");
	console.log("   3. Send it to the mempool");
	console.log("   4. Mine a block to include it\n");

	// Example transaction to contract (even though it won't update anything)
	const exampleCallData = new Uint8Array(32); // 32 bytes of zeros
	const exampleTx = createTransaction({
		type: "legacy",
		nonce: deployerAccountAfter.nonce,
		gasPrice: 1000000000n,
		gasLimit: 100000n,
		to: contractAddress as any,
		value: 0n,
		data: exampleCallData,
		chainId: client.config.chainId,
	});

	const signedExampleTx = signTransaction(
		exampleTx,
		deployerKey.privateKey.raw,
	);
	clientSendTransaction(client, signedExampleTx);
	console.log("   ✓ Example transaction sent to mempool");
	console.log("   (Would need to mine block to execute)\n");

	// Check balances
	console.log("7. Final state:");
	const deployerBalance = clientGetBalance(client, deployerAddress);
	const contractAccount = getAccount(
		client.stateManager,
		contractAddress as any,
	);
	console.log(`   Deployer balance: ${deployerBalance.toString()} wei`);
	console.log(`   Contract balance: ${contractAccount.balance.toString()} wei`);
	console.log(
		`   Contract code length: ${(await import("../src/blockchain/state/state-manager")).getAccountCode(client.stateManager, contractAddress as any).length} bytes`,
	);

	console.log("\n=== Interaction Demo Complete! ===");
	console.log("\nSummary of interaction methods:");
	console.log("1. readStorageValue() - Read-only call (no transaction needed)");
	console.log("2. clientCall() - Direct EVM call (read-only)");
	console.log(
		"3. sendContractTransaction() - State-changing transaction (requires mining)",
	);
	console.log(
		"4. clientSendTransaction() + clientMineBlock() - Manual transaction flow",
	);
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
