// script/demo-contract.ts
// Demo script for deploying and interacting with a smart contract

import {
	addressFromPrivateKey,
	clientCall,
	clientGetBalance,
	clientMineBlock,
	clientSendTransaction,
	clientStart,
	createBlockchainClient,
	createTransaction,
	signTransaction,
} from "../src/blockchain";
import {
	getAccount,
	getAccount as getAccountState,
	putAccount,
} from "../src/blockchain/state/state-manager";
import {
	calculateContractAddress,
	createGetValueCallData,
	createStorageContractDeploymentData,
	decodeUint256ReturnData,
} from "../src/blockchain/utils/contracts";
import { createNode } from "../src/node/createNode";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000;

async function main() {
	console.log("=== Smart Contract Deployment Demo ===\n");

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
	console.log("Waiting for network to bootstrap...");
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Mine genesis block
	console.log("\n1. Mining genesis block...");
	const genesisBlock = clientMineBlock(client);
	if (genesisBlock) {
		console.log(
			`   ✓ Genesis block mined: #${genesisBlock.header.number.toString()}`,
		);
	}

	// Create deployer account
	const deployerKey = generateSecp256k1KeyPrivPubPair();
	const deployerAddress = addressFromPrivateKey(deployerKey.privateKey.raw);

	// Give deployer some balance
	const deployerAccount = getAccount(client.stateManager, deployerAddress);
	deployerAccount.balance = 5000000000000000000n; // 5 ETH
	putAccount(client.stateManager, deployerAddress, deployerAccount);
	console.log(`\n2. Allocated 5 ETH to deployer: ${deployerAddress}`);

	// Deploy contract with initial value of 42
	console.log("\n3. Deploying SimpleStorage contract with initial value 42...");
	const initialValue = 42n;
	const contractBytecode = createStorageContractDeploymentData(initialValue);

	const deployTx = createTransaction({
		type: "legacy",
		nonce: 0n,
		gasPrice: 1000000000n, // 1 gwei
		gasLimit: 1000000n, // Enough gas for deployment
		to: undefined, // No 'to' means contract creation
		value: 0n,
		data: contractBytecode,
		chainId: client.config.chainId,
	});

	const signedDeployTx = signTransaction(deployTx, deployerKey.privateKey.raw);
	clientSendTransaction(client, signedDeployTx);
	console.log(`   ✓ Deployment transaction sent`);

	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Mine block with deployment transaction
	console.log("\n4. Mining block with deployment transaction...");
	const deployBlock = clientMineBlock(client);
	if (deployBlock) {
		console.log(`   ✓ Block mined: #${deployBlock.header.number.toString()}`);
		console.log(
			`   ✓ Transactions in block: ${deployBlock.transactions.length}`,
		);
	}

	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Get contract address from transaction receipt
	// Contract address = keccak256(RLP([sender, nonce]))[12:]
	const deployerAccountAfter = getAccountState(
		client.stateManager,
		deployerAddress,
	);
	const contractNonce = deployerAccountAfter.nonce - 1n; // Nonce before deployment

	// Calculate contract address
	const contractAddress = calculateContractAddress(
		deployerAddress,
		contractNonce,
	);

	console.log(`\n5. Contract deployed at address: ${contractAddress}`);
	console.log(
		`   Deployer nonce after deployment: ${deployerAccountAfter.nonce.toString()}`,
	);

	// Call contract to get stored value
	console.log("\n6. Calling contract get() function...");
	const getCallData = createGetValueCallData();
	const returnData = clientCall(
		client,
		contractAddress as any,
		getCallData,
		deployerAddress,
		0n,
	);
	const storedValue = decodeUint256ReturnData(returnData);
	console.log(`   ✓ Stored value: ${storedValue.toString()}`);

	// Note: The simple contract only has a getter function
	// To add a setter, we'd need more complex bytecode with function selectors
	// For this demo, we'll just verify the contract works by reading the stored value
	console.log("\n7. Contract deployed successfully!");
	console.log(
		`   The contract stores value ${initialValue.toString()} in storage slot 0`,
	);
	console.log(`   Calling the contract returns this stored value`);

	// Check balances
	console.log("\n10. Final balances:");
	const deployerBalance = clientGetBalance(client, deployerAddress);
	console.log(`    Deployer balance: ${deployerBalance.toString()} wei`);

	console.log("\n=== Contract Demo Complete! ===");
}

main().catch((err) => {
	console.error("Demo failed:", err);
	process.exit(1);
});
