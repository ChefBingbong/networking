// script/demo-blockchain.ts

import {
	addressFromPrivateKey,
	clientGetBalance,
	clientMineBlock,
	clientSendTransaction,
	clientStart,
	createBlockchainClient,
	createTransaction,
	signTransaction,
} from "../src/blockchain";
import { getAccount, putAccount } from "../src/blockchain/state/state-manager";
import { createNode } from "../src/node/createNode";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000;
const NODE_COUNT = 50;

async function main() {
	console.log(`Creating ${NODE_COUNT} blockchain nodes...`);

	const nodes = [];
	const clients = [];

	// Create nodes and blockchain clients
	for (let i = 0; i < NODE_COUNT; i++) {
		const node = await createNode({
			host: HOST,
			port: BASE_PORT + i,
			start: false,
			nodeTypes: "peer",
		});

		await node.start();

		// Create blockchain client
		const keyPair = generateSecp256k1KeyPrivPubPair();
		// Get private key bytes for address generation
		const privateKeyBytes = keyPair.privateKey.raw;
		const minerAddress = addressFromPrivateKey(privateKeyBytes);

		const client = createBlockchainClient(
			node,
			"local",
			undefined,
			minerAddress,
		);
		await clientStart(client);

		nodes.push(node);
		clients.push(client);

		console.log(
			`Node ${i} created: ${node.address.toString()}, miner: ${minerAddress}`,
		);
	}

	// Wait for network to bootstrap
	console.log("\nWaiting for network to bootstrap...");
	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Mine genesis block on first node
	console.log("\nMining genesis block...");
	const genesisBlock = clientMineBlock(clients[0]!);

	console.log(genesisBlock);
	if (genesisBlock) {
		console.log(`Genesis block mined: ${genesisBlock.header.number}`);
	}

	// Create and send a transaction
	console.log("\nCreating transaction...");
	const senderKey = generateSecp256k1KeyPrivPubPair();
	const senderAddress = addressFromPrivateKey(senderKey.privateKey.raw);

	const receiverKey = generateSecp256k1KeyPrivPubPair();
	const receiverAddress = addressFromPrivateKey(receiverKey.privateKey.raw);

	// Give sender some initial balance by mining a block that allocates it
	// For demo purposes, we'll manually set the balance
	const senderAccount = getAccount(clients[0]!.stateManager, senderAddress);
	senderAccount.balance = 2000000000000000000n; // 2 ETH
	putAccount(clients[0]!.stateManager, senderAddress, senderAccount);
	console.log(
		`Allocated ${senderAccount.balance} wei to sender ${senderAddress}`,
	);

	const tx = createTransaction({
		type: "legacy",
		nonce: 0n,
		gasPrice: 1000000000n, // 1 gwei
		gasLimit: 21000n,
		to: receiverAddress,
		value: 1000000000000000000n, // 1 ETH
		data: new Uint8Array(0),
		chainId: clients[0]!.config.chainId, // Set chainId for EIP-155
	});

	const signedTx = signTransaction(tx, senderKey.privateKey.raw);
	await new Promise((resolve) => setTimeout(resolve, 3000));

	clientSendTransaction(clients[0]!, signedTx);
	console.log(`Transaction sent from ${senderAddress} to ${receiverAddress}`);
	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Mine a block with the transaction
	console.log("\nMining block with transaction...");
	const block = clientMineBlock(clients[0]!);
	if (block) {
		console.log(
			`Block mined: ${block.header.number}, gasUsed: ${block.header.gasUsed}`,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Check balances
	console.log("\nChecking balances...");
	const senderBalance = clientGetBalance(clients[0]!, senderAddress);
	const receiverBalance = clientGetBalance(clients[0]!, receiverAddress);
	console.log(`Sender balance: ${senderBalance}`);
	console.log(`Receiver balance: ${receiverBalance}`);

	console.log("\nBlockchain demo complete!");
}

main().catch((err) => {
	console.error("Demo failed:", err);
	// process.exit(1);
});
