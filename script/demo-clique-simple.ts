// Simplified Clique consensus demo - all setup handled in createBlockchainClient

import fs from "fs";
import {
	addressFromPrivateKey,
	clientGetBalance,
	clientMineBlock,
	clientSendTransaction,
	clientStart,
	createBlockchainClient,
	createTransaction,
	type GenesisConfig,
	getChainConfig,
	signTransaction,
} from "../src/blockchain";
import { getCanonicalHead } from "../src/blockchain/blockchain/chain";
import {
	cliqueActiveSigners,
	cliqueSigner,
} from "../src/blockchain/consensus/clique";
import {
	CLIQUE_DIFF_INTURN,
	CLIQUE_DIFF_NOTURN,
} from "../src/blockchain/consensus/clique/types";
import { createNodeWithKey } from "../src/node/createNode";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000;
const NODE_COUNT = 3;

const DB_BASE_PATH = "./clique/clique-db-simple";

async function cleanupDatabases() {
	for (let i = 0; i < NODE_COUNT; i++) {
		const dbPath = `${DB_BASE_PATH}-${i}`;
		if (fs.existsSync(dbPath)) {
			fs.rmSync(dbPath, { recursive: true, force: true });
			console.log(`Cleaned up database: ${dbPath}`);
		}
	}
}

async function main() {
	console.log(`=== Clique Consensus Demo ===\n`);

	cleanupDatabases();

	const nodes = [];
	const clients = [];
	const signerKeys: Array<{ address: string; privateKey: Uint8Array }> = [];

	// Create nodes and extract their keys to use as signer keys
	console.log(`Creating ${NODE_COUNT} Clique signer nodes...`);
	for (let i = 0; i < NODE_COUNT; i++) {
		const { node, privateKey: nodePrivateKeyBytes } = await createNodeWithKey({
			host: HOST,
			port: BASE_PORT + i,
			start: false,
			nodeTypes: "peer",
		});

		// Use the node's private key as the signer key
		const signerAddress = addressFromPrivateKey(nodePrivateKeyBytes);
		signerKeys.push({
			address: signerAddress,
			privateKey: nodePrivateKeyBytes,
		});
		console.log(`Signer ${i}: ${signerAddress}`);
		nodes.push(node);
	}

	// Extract signer addresses for Clique genesis setup
	const signerAddresses = signerKeys.map((key) => key.address);
	const senderKey = generateSecp256k1KeyPrivPubPair();
	const senderAddress = addressFromPrivateKey(senderKey.privateKey.raw);

	const receiverKey = generateSecp256k1KeyPrivPubPair();
	const receiverAddress = addressFromPrivateKey(receiverKey.privateKey.raw);

	const genesisConfig: GenesisConfig = {
		...getChainConfig("clique").genesis,
		alloc: {
			[senderAddress]: {
				balance: "0x1bc16d674ec80000", // 2 ETH in hex (2000000000000000000 wei)
			},
		},
	};
	console.log(
		`\nCreating ${NODE_COUNT} blockchain clients with Clique consensus...\n`,
	);

	// Create blockchain clients with Clique enabled - all setup handled automatically
	for (let i = 0; i < NODE_COUNT; i++) {
		const node = nodes[i]!;
		const signerKey = signerKeys[i]!;

		// Create client with Clique config - genesis extraData setup handled automatically
		const client = createBlockchainClient(
			node,
			"clique", // Use Clique config
			genesisConfig, // Genesis config will be auto-generated with signers
			signerKey.address,
			`${DB_BASE_PATH}-${i}`, // DB path
			signerKey.privateKey, // Miner private key for signing
			signerAddresses, // All signer addresses for genesis setup
		);
		node.setBlockchainClient(client);

		await node.start();
		await clientStart(client);

		clients.push(client);
		console.log(
			`Node ${i} created: ${node.address.toString()}, signer: ${signerKey.address}`,
		);
	}

	// Connect nodes
	console.log("\nConnecting nodes...");
	for (let i = 0; i < NODE_COUNT; i++) {
		const nextIndex = (i + 1) % NODE_COUNT;
		await nodes[i]!.dial(nodes[nextIndex]!.address);
		console.log(`Node ${i} connected to node ${nextIndex}`);
	}

	// Wait for network to stabilize
	console.log("\nWaiting for network to stabilize...");
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Mine blocks with each signer
	console.log("\n=== Mining Blocks ===\n");
	for (let i = 0; i < NODE_COUNT; i++) {
		const signerIndex = i;
		const client = clients[signerIndex]!;
		const signerAddress = signerKeys[signerIndex]!.address;

		console.log(
			`Mining block ${i} with signer ${signerIndex} (${signerAddress})`,
		);

		const tx = createTransaction({
			type: "legacy",
			nonce: BigInt(i),
			gasPrice: 1000000000n, // 1 gwei
			gasLimit: 21000n,
			to: receiverAddress,
			value: 500000000000000000n, // 1 ETH
			data: new Uint8Array(0),
			chainId: clients[0]!.config.chainId, // Set chainId for EIP-155
		});

		const signedTx = signTransaction(tx, senderKey.privateKey.raw);
		await new Promise((resolve) => setTimeout(resolve, 3000));

		clientSendTransaction(client, signedTx);
		console.log(`Transaction sent from ${senderAddress} to ${receiverAddress}`);

		await new Promise((resolve) => setTimeout(resolve, 3000));
		const block = await clientMineBlock(client);
		await new Promise((resolve) => setTimeout(resolve, 3000));

		if (block) {
			const signer = cliqueSigner(block.header);
			const difficulty = block.header.difficulty;
			const signers = cliqueActiveSigners(client.clique!, block.header.number);
			const signerIndexInList = signers.findIndex(
				(addr) => addr.toLowerCase() === signerAddress.toLowerCase(),
			);
			const expectedInTurn =
				block.header.number % BigInt(signers.length) ===
				BigInt(signerIndexInList);
			const expectedDifficulty = expectedInTurn
				? CLIQUE_DIFF_INTURN
				: CLIQUE_DIFF_NOTURN;

			console.log(
				`  ✓ Block #${block.header.number}, signer: ${signer}, difficulty: ${difficulty} (${expectedInTurn ? "INTURN" : "NOTURN"})`,
			);

			if (signer.toLowerCase() !== signerAddress.toLowerCase()) {
				console.error(
					`  ✗ Signer mismatch! Expected ${signerAddress}, got ${signer}`,
				);
			}

			if (difficulty !== expectedDifficulty) {
				console.error(
					`  ✗ Difficulty mismatch! Expected ${expectedDifficulty}, got ${difficulty}`,
				);
			}
		} else {
			console.error(`  ✗ Failed to mine block ${i}`);
		}

		// Wait for block propagation
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	// Verify chain synchronization
	console.log("\n=== Chain Synchronization ===");
	const head0 = getCanonicalHead(clients[0]!.chain);
	if (head0) {
		console.log(`Node 0 head: Block #${head0.header.number}`);
		for (let i = 1; i < NODE_COUNT; i++) {
			const head = getCanonicalHead(clients[i]!.chain);
			if (
				head &&
				head.header.number === head0.header.number &&
				head.header.parentHash === head0.header.parentHash
			) {
				console.log(`Node ${i} head: Block #${head.header.number}`);
			} else {
				console.error(
					`  ✗ Chain synchronization failed for Node ${i}! Expected head #${head0.header.number}, got #${head?.header.number}`,
				);
			}
		}
		console.log("  ✓ Chains synchronized");
	} else {
		console.error("  ✗ Node 0 has no canonical head!");
	}

	// Test: Database Persistence (check active signers from DB)
	console.log("\n=== Active Signers (from DB) ===");
	for (let i = 0; i < NODE_COUNT; i++) {
		const client = clients[i]!;
		const activeSigners = cliqueActiveSigners(
			client.clique!,
			getCanonicalHead(client.chain)?.header.number ?? 0n,
		);
		console.log(`Node ${i}: ${activeSigners.length} signers`);
		activeSigners.forEach((s, idx) => console.log(`  [${idx}] ${s}`));
	}

	console.log("\n=== Clique Demo Complete ===");

	console.log("\nDatabase directories:");
	for (let i = 0; i < NODE_COUNT; i++) {
		const dbPath = `${DB_BASE_PATH}-${i}`;
		if (fs.existsSync(dbPath)) {
			const files = fs.readdirSync(dbPath).length;
			console.log(`  ${dbPath}: ${files} files`);
		}
	}

	// Close all databases
	for (const client of clients) {
		if (client.db) {
			await client.db.close();
		}
	}

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
	process.exit(1);
});
