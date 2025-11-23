// script/demo-clique.ts
// Test script for Clique consensus and LevelDB persistence

import fs from "fs";
import {
	addressFromPrivateKey,
	clientMineBlock,
	clientStart,
	createBlockchainClient,
} from "../src/blockchain";
import { blockHash } from "../src/blockchain/block/block";
import { getCanonicalHead } from "../src/blockchain/blockchain/chain";
import {
	cliqueActiveSigners,
	cliqueGenesisInit,
	cliqueSigner,
	createCliqueConsensus,
	setupCliqueConsensus,
} from "../src/blockchain/consensus/clique";
import {
	CLIQUE_DIFF_INTURN,
	CLIQUE_DIFF_NOTURN,
} from "../src/blockchain/consensus/clique/types";
import { createDatabase } from "../src/blockchain/db/database";
import type { GenesisConfig } from "../src/blockchain/types";
import { hexToBytes } from "../src/blockchain/utils";
import { generateSecp256k1KeyPrivPubPair } from "../src/secp256k1/utils";

const HOST = "127.0.0.1";
const BASE_PORT = 4000; // Different port range to avoid conflicts
const NODE_COUNT = 3; // 3 signers for Clique
const DB_BASE_PATH = "./clique/clique-db";

// Clean up old database directories
function cleanupDatabases() {
	for (let i = 0; i < NODE_COUNT; i++) {
		const dbPath = `${DB_BASE_PATH}-${i}`;
		if (fs.existsSync(dbPath)) {
			fs.rmSync(dbPath, { recursive: true, force: true });
			console.log(`Cleaned up database: ${dbPath}`);
		}
	}
}

// Create a Clique-enabled chain config
function getCliqueChainConfig() {
	return {
		chainId: 1337n,
		name: "clique-test",
		hardforks: [
			{
				name: "frontier",
				block: 0n,
				eips: [],
			},
			{
				name: "homestead",
				block: 0n,
				eips: [2, 7, 8],
			},
		],
		genesis: {
			timestamp: "0x0",
			gasLimit: "0x1c9c380",
			difficulty: "0x1",
			extraData: "0x", // Will be set with signers for epoch transition
			alloc: {},
		},
		clique: {
			epoch: 5, // Small epoch for testing (every 5 blocks)
			period: 5, // 5 seconds between blocks
		},
	};
}

async function main() {
	console.log("=== Clique Consensus & LevelDB Test ===\n");

	// Clean up old databases
	cleanupDatabases();

	console.log(`Creating ${NODE_COUNT} Clique signer nodes...`);

	const nodes = [];
	const clients = [];
	const signerKeys: Array<{ address: string; privateKey: Uint8Array }> = [];

	// Create nodes first and extract their keys to use as signer keys
	const { createNodeWithKey } = await import("../src/node/createNode");
	for (let i = 0; i < NODE_COUNT; i++) {
		const { node, privateKey: nodePrivateKeyBytes } = await createNodeWithKey({
			host: HOST,
			port: BASE_PORT + i,
			start: false,
			nodeTypes: "peer",
		});

		await node.start();

		// Use the node's private key as the signer key
		const signerAddress = addressFromPrivateKey(nodePrivateKeyBytes);
		signerKeys.push({
			address: signerAddress,
			privateKey: nodePrivateKeyBytes,
		});
		console.log(`Signer ${i}: ${signerAddress}`);
		nodes.push(node);
	}

	// Create genesis extraData with signers (for epoch transition)
	// Format: [vanity (32 bytes)][signers (20 bytes each)][signature (65 bytes)]
	// We'll create a temporary header to sign, then use that extraData
	const vanity = new Uint8Array(32).fill(0);
	const signersData = new Uint8Array(signerKeys.length * 20);
	for (let i = 0; i < signerKeys.length; i++) {
		const signerBytes = Uint8Array.from(
			Buffer.from(signerKeys[i]!.address.slice(2), "hex"),
		);
		signersData.set(signerBytes, i * 20);
	}

	// Create a temporary header for signing (without signature)
	const { createHeader } = await import("../src/blockchain/block/header");

	// Create extraData with vanity + signers (without signature)
	const extraDataWithoutSig = new Uint8Array(32 + signersData.length);
	extraDataWithoutSig.set(vanity, 0);
	extraDataWithoutSig.set(signersData, 32);

	const tempHeader = createHeader({
		number: 0n,
		gasLimit: BigInt("0x1c9c380"),
		difficulty: BigInt("0x1"),
		timestamp: 0n,
		extraData: extraDataWithoutSig, // Vanity + signers, no signature
	});

	// Sign the header with first signer
	// signCliqueHeader expects the header to already have extraData set (without signature)
	const { signCliqueHeader: signCliqueHeaderUtil } = await import(
		"../src/blockchain/consensus/clique/utils"
	);
	const signedHeader = signCliqueHeaderUtil(
		tempHeader, // tempHeader already has extraDataWithoutSig set
		signerKeys[0]!.privateKey,
	);

	// Verify the signed header has correct length
	const expectedLength = 32 + signersData.length + 65; // vanity + signers + signature
	if (signedHeader.extraData.length !== expectedLength) {
		console.error(
			`✗ Signed header extraData length mismatch! Expected ${expectedLength}, got ${signedHeader.extraData.length}`,
		);
	} else {
		console.log(
			`✓ Genesis header signed correctly: ${signedHeader.extraData.length} bytes (${signerKeys.length} signers)`,
		);
	}

	const genesisConfig: GenesisConfig = {
		timestamp: "0x0",
		gasLimit: "0x1c9c380",
		difficulty: "0x1",
		extraData: `0x${Buffer.from(signedHeader.extraData).toString("hex")}`, // With signers and signature
		alloc: {},
	};

	// Create blockchain clients with Clique enabled
	for (let i = 0; i < NODE_COUNT; i++) {
		const node = nodes[i]!;
		const signerKey = signerKeys[i]!;
		const dbPath = `${DB_BASE_PATH}-${i}`;

		// Create blockchain client with Clique and DB
		// We need to manually create config with Clique enabled
		const cliqueConfig = getCliqueChainConfig();
		cliqueConfig.genesis.extraData = genesisConfig.extraData;

		console.log(cliqueConfig);
		// Create client with a temporary config, then override
		// We'll manually create DB and Clique after
		const client = createBlockchainClient(
			node,
			"local",
			genesisConfig,
			signerKey.address,
		);

		// Override config to enable Clique
		client.config = cliqueConfig;

		client.db = createDatabase(dbPath);
		client.clique = createCliqueConsensus(client.db, cliqueConfig.clique!);

		// Store miner private key for Clique signing
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(client as any).minerPrivateKey = signerKey.privateKey;

		// Update genesis block extraData with signers and signature from genesisConfig
		// The genesisConfig already has the signed extraData with signers
		const genesisExtraDataBytes = hexToBytes(genesisConfig.extraData);

		// Debug: Check extraData length before updating
		console.log(
			`  Node ${i}: Genesis extraData length from config: ${genesisExtraDataBytes.length} bytes (expected: ${32 + signerKeys.length * 20 + 65})`,
		);

		// Update the genesis block header
		client.chain.genesis.header.extraData = genesisExtraDataBytes;

		// IMPORTANT: Also update the header stored in chain.headers map
		// The block object references the header, but we need to update the stored header too
		const genesisHash = blockHash(client.chain.genesis);
		client.chain.genesis.header = { ...client.chain.genesis.header }; // Create new object reference
		client.chain.blocks.set(genesisHash, client.chain.genesis);
		client.chain.headers.set(genesisHash, client.chain.genesis.header);

		// Verify the extraData was set correctly
		if (
			client.chain.genesis.header.extraData.length !==
			genesisExtraDataBytes.length
		) {
			console.error(
				`  ✗ ExtraData length mismatch! Block: ${client.chain.genesis.header.extraData.length}, Config: ${genesisExtraDataBytes.length}`,
			);
		}

		// Initialize Clique consensus BEFORE clientStart
		// This will load signers from DB and initialize genesis signers
		await setupCliqueConsensus(client.clique);

		// Verify genesis block has correct extraData before initializing
		const genesisExtraDataLength = client.chain.genesis.header.extraData.length;
		const expectedLength = 32 + signerKeys.length * 20 + 65; // vanity + signers + signature
		if (genesisExtraDataLength !== expectedLength) {
			console.error(
				`  ✗ Node ${i}: Genesis block extraData length incorrect! Expected ${expectedLength}, got ${genesisExtraDataLength}`,
			);
			console.error(
				`    This will cause signer extraction to fail. Check if extraData was updated correctly.`,
			);
		}

		await cliqueGenesisInit(client.clique, client.chain.genesis);

		// Verify signers were loaded
		const initialSigners = cliqueActiveSigners(client.clique, 0n);
		if (initialSigners.length === 0) {
			console.error(
				`  ✗ Failed to initialize signers for node ${i}. Genesis block extraData length: ${genesisExtraDataLength}`,
			);
			// Debug: Check if epoch transition check passes
			const { cliqueIsEpochTransition } = await import(
				"../src/blockchain/consensus/clique/utils"
			);
			const isEpoch = cliqueIsEpochTransition(
				client.chain.genesis.header,
				cliqueConfig.clique!.epoch,
			);
			console.error(`    Is epoch transition: ${isEpoch}`);
			if (genesisExtraDataLength >= 97) {
				// Should have at least vanity (32) + 1 signer (20) + signature (65) = 117
				const signersData = client.chain.genesis.header.extraData.slice(
					32,
					-65,
				);
				console.error(
					`    Signers data length: ${signersData.length}, expected: ${signerKeys.length * 20}`,
				);
			}
		} else {
			console.log(
				`  ✓ Initialized ${initialSigners.length} signers for node ${i}`,
			);
		}

		await clientStart(client);

		nodes.push(node);
		clients.push(client);

		console.log(
			`Node ${i} created: ${node.address.toString()}, signer: ${signerKey.address}, DB: ${dbPath}`,
		);
	}

	// Connect nodes in a ring
	console.log("\nConnecting nodes...");
	for (let i = 0; i < NODE_COUNT; i++) {
		const nextIndex = (i + 1) % NODE_COUNT;
		try {
			await nodes[i]!.dial(nodes[nextIndex]!.address);
			console.log(`Node ${i} connected to node ${nextIndex}`);
		} catch (err) {
			console.error(`Failed to connect node ${i} to ${nextIndex}:`, err);
		}
	}

	// Wait for network to stabilize
	console.log("\nWaiting for network to stabilize...");
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Test 1: Mine blocks with signer rotation
	console.log("\n=== Test 1: Signer Rotation ===");
	for (let i = 0; i < NODE_COUNT * 2; i++) {
		const signerIndex = i % NODE_COUNT;
		const client = clients[signerIndex]!;
		const signerAddress = signerKeys[signerIndex]!.address;

		console.log(
			`\nMining block ${i} with signer ${signerIndex} (${signerAddress})`,
		);

		// Get current head
		const head = getCanonicalHead(client.chain);
		if (!head) {
			console.error("No head block found");
			continue;
		}

		// Check if signer is in turn
		if (client.clique) {
			const nextBlockNumber = head.header.number + 1n;
			const signers = cliqueActiveSigners(client.clique, nextBlockNumber);

			if (signers.length === 0) {
				console.error(
					`  ✗ No signers available for block ${nextBlockNumber}! Clique not properly initialized.`,
				);
				console.error(
					`  Clique state: ${JSON.stringify({
						signerStates: client.clique._cliqueLatestSignerStates.length,
						votes: client.clique._cliqueLatestVotes.length,
						blockSigners: client.clique._cliqueLatestBlockSigners.length,
					})}`,
				);
				continue;
			}

			console.log(
				`  Active signers (${signers.length}): ${signers.map((s) => s.slice(0, 10) + "...").join(", ")}`,
			);
			const expectedSignerIndex = Number(
				nextBlockNumber % BigInt(signers.length),
			);
			const expectedSigner = signers[expectedSignerIndex];
			const inTurn =
				signerAddress.toLowerCase() === expectedSigner?.toLowerCase();

			console.log(
				`  Expected signer: ${expectedSigner} (index ${expectedSignerIndex}), In turn: ${inTurn}`,
			);
			console.log(
				`  Expected difficulty: ${inTurn ? CLIQUE_DIFF_INTURN : CLIQUE_DIFF_NOTURN}`,
			);
		}

		const block = await clientMineBlock(client);
		if (block) {
			const signer = cliqueSigner(block.header);
			const difficulty = block.header.difficulty;
			console.log(
				`  ✓ Block mined: #${block.header.number}, signer: ${signer}, difficulty: ${difficulty}`,
			);

			// Verify signer matches
			if (signer.toLowerCase() !== signerAddress.toLowerCase()) {
				console.error(
					`  ✗ Signer mismatch! Expected ${signerAddress}, got ${signer}`,
				);
			} else {
				console.log(`  ✓ Signer matches: ${signer} === ${signerAddress}`);
			}

			// Verify difficulty
			if (client.clique) {
				const signers = cliqueActiveSigners(client.clique, block.header.number);
				const signerIndex = signers.findIndex(
					(addr) => addr.toLowerCase() === signerAddress.toLowerCase(),
				);
				const expectedInTurn =
					block.header.number % BigInt(signers.length) === BigInt(signerIndex);
				const expectedDifficulty = expectedInTurn
					? CLIQUE_DIFF_INTURN
					: CLIQUE_DIFF_NOTURN;

				if (difficulty !== expectedDifficulty) {
					console.error(
						`  ✗ Difficulty mismatch! Expected ${expectedDifficulty}, got ${difficulty}`,
					);
				} else {
					console.log(
						`  ✓ Difficulty correct: ${expectedInTurn ? "INTURN" : "NOTURN"}`,
					);
				}
			}

			// Wait for block propagation
			await new Promise((resolve) => setTimeout(resolve, 1000));
		} else {
			console.error(`  ✗ Failed to mine block ${i}`);
		}
	}

	// Test 2: Verify all nodes have same chain state
	console.log("\n=== Test 2: Chain Synchronization ===");
	const head0 = getCanonicalHead(clients[0]!.chain);
	if (head0) {
		console.log(`Node 0 head: Block #${head0.header.number}`);
		for (let i = 1; i < NODE_COUNT; i++) {
			const head = getCanonicalHead(clients[i]!.chain);
			if (head) {
				console.log(`Node ${i} head: Block #${head.header.number}`);
				if (head.header.number !== head0.header.number) {
					console.error(
						`  ✗ Chain mismatch! Node 0: #${head0.header.number}, Node ${i}: #${head.header.number}`,
					);
				} else {
					console.log(`  ✓ Chains synchronized`);
				}
			}
		}
	}

	// Test 3: Verify signer states in database
	console.log("\n=== Test 3: Database Persistence ===");
	for (let i = 0; i < NODE_COUNT; i++) {
		const client = clients[i]!;
		if (client.clique && client.db) {
			const signers = cliqueActiveSigners(
				client.clique,
				getCanonicalHead(client.chain)?.header.number ?? 0n,
			);
			console.log(`Node ${i} active signers (from DB): ${signers.length}`);
			signers.forEach((signer, idx) => {
				console.log(`  [${idx}] ${signer}`);
			});
			console.log(
				`  Block signers tracked: ${client.clique._cliqueLatestBlockSigners.length}`,
			);
			console.log(
				`  Votes tracked: ${client.clique._cliqueLatestVotes.length}`,
			);
		}
	}

	// Test 4: Test transaction processing
	console.log("\n=== Test 4: Transaction Processing ===");
	const senderKey = generateSecp256k1KeyPrivPubPair();
	const senderAddress = addressFromPrivateKey(senderKey.privateKey.raw);
	const receiverKey = generateSecp256k1KeyPrivPubPair();
	const receiverAddress = addressFromPrivateKey(receiverKey.privateKey.raw);

	// Allocate balance via genesis (would need to reinitialize, but for demo we'll skip)
	console.log(`Sender: ${senderAddress}`);
	console.log(`Receiver: ${receiverAddress}`);

	// Test 5: Epoch transition (if we mined enough blocks)
	console.log("\n=== Test 5: Epoch Transition Check ===");
	const currentHead = getCanonicalHead(clients[0]!.chain);
	if (currentHead && clients[0]!.config.clique) {
		const epoch = clients[0]!.config.clique.epoch;
		const blockNumber = Number(currentHead.header.number);
		const blocksUntilEpoch = epoch - (blockNumber % epoch);
		console.log(
			`Current block: ${blockNumber}, Epoch: ${epoch}, Blocks until next epoch: ${blocksUntilEpoch}`,
		);

		if (blocksUntilEpoch <= 2) {
			console.log("  Mining blocks to trigger epoch transition...");
			for (let i = 0; i < blocksUntilEpoch; i++) {
				const signerIndex = Number(
					(currentHead.header.number + BigInt(i + 1)) % BigInt(NODE_COUNT),
				);
				const block = await clientMineBlock(clients[signerIndex]!);
				if (block) {
					console.log(`  Block #${block.header.number} mined`);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}

			// Check if epoch transition occurred
			const newHead = getCanonicalHead(clients[0]!.chain);
			if (newHead && newHead.header.number % BigInt(epoch) === 0n) {
				console.log(`  ✓ Epoch transition at block #${newHead.header.number}`);
			}
		} else {
			console.log(`  Not enough blocks mined yet for epoch transition test`);
		}
	}

	console.log("\n=== Clique & DB Test Complete ===");
	console.log("\nDatabase directories:");
	for (let i = 0; i < NODE_COUNT; i++) {
		const dbPath = `${DB_BASE_PATH}-${i}`;
		if (fs.existsSync(dbPath)) {
			const files = fs.readdirSync(dbPath);
			console.log(`  ${dbPath}: ${files.length} files`);
		}
	}
}

main().catch((err) => {
	console.error("Test failed:", err);
	process.exit(1);
});
