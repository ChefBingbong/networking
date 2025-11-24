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
import type { GenesisConfig } from "../src/blockchain/types";
import { createNode } from "../src/node/createNode";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000;
const NODE_COUNT = 5;

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

	// Create sender/receiver addresses
	const senderKey = generateSecp256k1KeyPrivPubPair();
	const senderAddress = addressFromPrivateKey(senderKey.privateKey.raw);

	const receiverKey = generateSecp256k1KeyPrivPubPair();
	const receiverAddress = addressFromPrivateKey(receiverKey.privateKey.raw);

	// Create genesis config with balance allocation
	// All nodes will use this same genesis, ensuring consistent initial state
	const genesisConfig: GenesisConfig = {
		timestamp: "0x0",
		gasLimit: "0x1c9c380",
		difficulty: "0x1",
		extraData: "0x",
		alloc: {
			[senderAddress]: {
				balance: "0x1bc16d674ec80000", // 2 ETH in hex (2000000000000000000 wei)
			},
		},
	};

	console.log(
		`\nRe-initializing genesis on all nodes with allocation for ${senderAddress}...`,
	);

	// Re-initialize genesis on all nodes with the allocation
	// This ensures all nodes have the same initial state from genesis
	for (let i = 0; i < NODE_COUNT; i++) {
		const { initializeGenesis } = await import(
			"../src/blockchain/config/genesis"
		);
		initializeGenesis(
			clients[i]!.chain,
			genesisConfig,
			clients[i]!.stateManager,
		);
		// Update genesis block state root
		const { calculateStateRoot } = await import(
			"../src/blockchain/state/state-manager"
		);
		const stateRoot = calculateStateRoot(clients[i]!.stateManager);
		clients[i]!.chain.genesis.header.stateRoot = stateRoot;
	}

	console.log(`Allocated 2 ETH to sender ${senderAddress} via genesis`);

	// Wait for network to bootstrap
	console.log("\nWaiting for network to bootstrap...");
	await new Promise((resolve) => setTimeout(resolve, 3000));

	// All nodes now have the same genesis state
	// When blocks are broadcast, all nodes will verify and process them independently
	console.log("\nAll nodes initialized with same genesis state");

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
	const block = await clientMineBlock(clients[0]!);
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
