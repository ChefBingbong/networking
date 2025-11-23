// src/blockchain/client/miner.ts

import { multiaddr } from "@multiformats/multiaddr";
import { stringifyWithBigInt } from "../../utils/utils";
import { blockHash, createBlock } from "../block/block";
import { createHeader } from "../block/header";
import { validateAndAddBlock } from "../blockchain/chain";
import {
	calculateReceiptsRoot,
	calculateTransactionsRoot,
	processBlock,
} from "../blockchain/processor";
import {
	cliqueActiveSigners,
	cliqueSignerInTurn,
} from "../consensus/clique/clique";
import {
	CLIQUE_DIFF_INTURN,
	CLIQUE_DIFF_NOTURN,
} from "../consensus/clique/types";
import {
	cliqueIsEpochTransition,
	signCliqueHeader,
} from "../consensus/clique/utils";
import { BLOCKCHAIN_PROTOCOL } from "../p2p/protocol";
import { removeTransaction } from "../p2p/tx-pool";
import { calculateStateRoot } from "../state/state-manager";
import { recoverSender, validateTransaction } from "../tx/transaction";
import type { Block, Hash, Transaction } from "../types";
import { addressFromPrivateKey, txHash } from "../utils";
import { serializeBlock } from "../utils/serialization";
import type { BlockchainClientState } from "./client";

export async function mineBlock(
	client: BlockchainClientState,
	txs: Transaction[],
	timestamp?: bigint,
): Promise<Block | null> {
	const parent = client.chain.blocks.get(client.chain.canonicalHead);
	if (!parent) {
		return null;
	}

	// Filter out invalid transactions (wrong nonce, insufficient balance, etc.)
	const validTxs = txs.filter((tx) => {
		if (!validateTransaction(tx, client.stateManager)) {
			return false;
		}
		const from = recoverSender(tx);
		if (!from) {
			return false;
		}
		// Additional check: ensure nonce matches current account state
		const account = client.stateManager.accounts.get(from);
		if (account && account.nonce !== tx.nonce) {
			return false;
		}
		return true;
	});

	console.log(
		`Preparing block with ${validTxs.length} transactions (filtered from ${txs.length})`,
	);
	const block = prepareBlock(client, parent, validTxs, timestamp);
	if (!block) {
		console.log("Failed to prepare block");
		return null;
	}

	console.log(`Block prepared with ${block.transactions.length} transactions`);

	// Handle Clique consensus vs PoW mining
	let minedBlock: Block | null;
	if (client.clique && client.config.clique) {
		// Clique consensus: sign the block instead of mining
		minedBlock = await signCliqueBlock(client, block);
		if (!minedBlock) {
			console.log("Failed to sign Clique block");
			return null;
		}
	} else {
		// PoW: mine the block
		minedBlock = mineHeader(block, block.header.difficulty);
		if (!minedBlock) {
			return null;
		}

		// Validate mined block
		if (!validateMinedBlock(minedBlock, block.header.difficulty)) {
			console.log("Mined block is not valid");
			return null;
		}
	}

	// Add block to chain
	if (!validateAndAddBlock(client.chain, minedBlock, client.clique)) {
		console.log("Failed to add block to chain");
		return null;
	}

	// Process block to update state (state was already updated in prepareBlock,
	// but we need to ensure consistency with the final mined block)
	const processResult = processBlock(
		client.chain,
		minedBlock,
		client.stateManager,
	);
	if (!processResult.success) {
		console.log("Failed to process mined block");
		return null;
	}

	console.log(
		`Block added and processed successfully, gasUsed: ${processResult.gasUsed.toString()}`,
	);

	// Remove successfully mined transactions from the pool
	for (const tx of minedBlock.transactions) {
		const hash = txHash(tx);
		removeTransaction(client.txPool, hash);
	}

	// Broadcast block to peers
	broadcastBlock(client, minedBlock);

	return minedBlock;
}

function broadcastBlock(client: BlockchainClientState, block: Block): void {
	const peers = client.node.connections.keys().toArray();

	console.log(peers, "kad peers");
	if (peers.length === 0) {
		console.log("[broadcastBlock] No peers to broadcast to");
		return;
	}

	// Serialize block to JSON string
	const blockJson = serializeBlock(block);

	const msg = {
		type: "NewBlock",
		block: blockJson,
	};

	console.log(
		`[broadcastBlock] Broadcasting block #${block.header.number.toString()} to ${peers.length} peers`,
	);
	for (const peerAddr of peers) {
		client.node
			.dialProtocol(multiaddr(peerAddr), BLOCKCHAIN_PROTOCOL)
			.then((stream) => {
				stream.send(Buffer.from(stringifyWithBigInt(msg), "utf-8"));
				setTimeout(() => {
					try {
						stream.close();
					} catch {}
				}, 1000);
			});
	}
}

export function prepareBlock(
	client: BlockchainClientState,
	parent: Block,
	txs: Transaction[],
	timestamp?: bigint,
): Block | null {
	console.log(`[prepareBlock] Preparing block with ${txs.length} transactions`);

	// Save current state before processing (we'll restore it after calculating roots)
	// processBlock will commit all checkpoints, so we need to save/restore manually
	// Deep copy accounts Map (including AccountState objects - need to copy bigints properly)
	const savedAccounts = new Map(
		Array.from(client.stateManager.accounts.entries()).map(
			([addr, account]) => [
				addr,
				{
					nonce: account.nonce, // bigint is immutable, so this is fine
					balance: account.balance, // bigint is immutable
					codeHash: account.codeHash,
					storageRoot: account.storageRoot,
				},
			],
		),
	);
	// Deep copy storage Map
	const savedStorage = new Map(
		Array.from(client.stateManager.storage.entries()).map(([addr, storage]) => [
			addr,
			new Map(storage), // Copy the storage Map
		]),
	);
	// Deep copy code Map (Uint8Array values need to be copied)
	const savedCode = new Map(
		Array.from(client.stateManager.code.entries()).map(([addr, code]) => [
			addr,
			new Uint8Array(code), // Copy the Uint8Array
		]),
	);

	// Log saved state for debugging
	const savedAccountEntries = Array.from(savedAccounts.entries());
	if (savedAccountEntries.length > 0) {
		const [firstAddr, firstAccount] = savedAccountEntries[0]!;
		console.log(
			`[prepareBlock] Saved state - accounts: ${savedAccounts.size}, first account (${firstAddr}): nonce=${firstAccount.nonce.toString()}, balance=${firstAccount.balance.toString()}`,
		);
	} else {
		console.log(`[prepareBlock] Saved state - accounts: ${savedAccounts.size}`);
	}

	// Create a temporary block for processing (with placeholder state root)
	const tempHeader = createHeader({
		parentHash: blockHash(parent),
		number: parent.header.number + 1n,
		gasLimit: parent.header.gasLimit,
		gasUsed: 0n,
		timestamp: timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
		stateRoot:
			"0x0000000000000000000000000000000000000000000000000000000000000000" as Hash,
		transactionsRoot:
			"0x0000000000000000000000000000000000000000000000000000000000000000" as Hash,
		receiptsRoot:
			"0x0000000000000000000000000000000000000000000000000000000000000000" as Hash,
		beneficiary: client.minerAddress,
		difficulty: parent.header.difficulty,
	});
	const tempBlock = createBlock(tempHeader, txs);

	// Process transactions (this will update state, but we'll restore it after)
	const result = processBlock(client.chain, tempBlock, client.stateManager);
	if (!result.success) {
		console.log(`[prepareBlock] Block processing failed`);
		return null;
	}

	// Calculate roots after processing
	const stateRoot = calculateStateRoot(client.stateManager);
	const transactionsRoot = calculateTransactionsRoot(txs);
	const receiptsRoot = calculateReceiptsRoot(result.receipts);

	console.log(
		`[prepareBlock] Calculated roots - stateRoot: ${stateRoot}, transactionsRoot: ${transactionsRoot}, receiptsRoot: ${receiptsRoot}`,
	);

	// Restore the original state - we don't want to commit state here
	// The actual state update will happen when mineBlock processes the block
	// Create new Maps with new AccountState objects to ensure we're not sharing references
	client.stateManager.accounts = new Map(
		Array.from(savedAccounts.entries()).map(([addr, account]) => [
			addr,
			{
				nonce: account.nonce,
				balance: account.balance,
				codeHash: account.codeHash,
				storageRoot: account.storageRoot,
			},
		]),
	);
	client.stateManager.storage = new Map(savedStorage);
	client.stateManager.code = new Map(savedCode);
	client.stateManager.checkpoints = []; // Clear any checkpoints

	// Verify restoration worked
	const restoredAccountEntries = Array.from(
		client.stateManager.accounts.entries(),
	);
	if (restoredAccountEntries.length > 0) {
		const [firstAddr, firstAccount] = restoredAccountEntries[0]!;
		console.log(
			`[prepareBlock] Restored original state, accounts: ${client.stateManager.accounts.size}, first account (${firstAddr}): nonce=${firstAccount.nonce.toString()}, balance=${firstAccount.balance.toString()}`,
		);
	} else {
		console.log(
			`[prepareBlock] Restored original state, accounts: ${client.stateManager.accounts.size}`,
		);
	}

	// Calculate difficulty (Clique uses INTURN/NOTURN, PoW uses difficulty adjustment)
	let newDifficulty: bigint;
	if (client.clique && client.config.clique) {
		// Clique difficulty will be set during signing
		newDifficulty = CLIQUE_DIFF_INTURN; // Placeholder, will be set correctly in signCliqueBlock
	} else {
		newDifficulty = calculateDifficulty(
			parent,
			timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
		);
	}

	// Adjust gas limit (simplified - target 50% usage)
	const gasLimit = adjustGasLimit(parent.header.gasLimit, result.gasUsed);

	// Create final header with correct roots
	const header = createHeader({
		parentHash: blockHash(parent),
		number: parent.header.number + 1n,
		gasLimit,
		gasUsed: result.gasUsed,
		timestamp: timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
		stateRoot,
		transactionsRoot,
		receiptsRoot,
		beneficiary: client.minerAddress,
		difficulty: newDifficulty,
	});

	return createBlock(header, txs);
}

/**
 * Sign a Clique block header
 */
async function signCliqueBlock(
	client: BlockchainClientState,
	block: Block,
): Promise<Block | null> {
	if (!client.clique || !client.config.clique) {
		return null;
	}

	// Get miner private key
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const minerPrivateKey = (client as any).minerPrivateKey as
		| Uint8Array
		| undefined;
	if (!minerPrivateKey) {
		console.error("Miner private key not found for Clique signing");
		return null;
	}

	// Verify the private key matches the miner address
	const derivedAddress = addressFromPrivateKey(minerPrivateKey);
	console.log(
		`[signCliqueBlock] Miner address: ${client.minerAddress}, derived from key: ${derivedAddress}`,
	);
	if (derivedAddress.toLowerCase() !== client.minerAddress.toLowerCase()) {
		console.error(
			`Miner address mismatch! Expected ${client.minerAddress}, derived ${derivedAddress} from private key`,
		);
		return null;
	}

	// Get current signers
	const signers = cliqueActiveSigners(client.clique, block.header.number);
	if (signers.length === 0) {
		console.error("No signers available for Clique block");
		return null;
	}

	// Check if this is an epoch transition block
	const isEpoch = cliqueIsEpochTransition(
		block.header,
		client.config.clique.epoch,
	);

	// Prepare extraData (vanity + signers if epoch transition)
	const vanity = new Uint8Array(32).fill(0); // 32 bytes of zeros
	let extraDataWithoutSig: Uint8Array;

	if (isEpoch) {
		// Epoch transition: include signers in extraData
		// Format: [vanity (32)][signers (20 bytes each)]
		const signersBytes = new Uint8Array(signers.length * 20);
		for (let i = 0; i < signers.length; i++) {
			const signerBytes = Uint8Array.from(
				Buffer.from(signers[i]!.slice(2), "hex"),
			);
			signersBytes.set(signerBytes, i * 20);
		}
		extraDataWithoutSig = new Uint8Array(32 + signersBytes.length);
		extraDataWithoutSig.set(vanity, 0);
		extraDataWithoutSig.set(signersBytes, 32);
	} else {
		// Normal block: just vanity
		extraDataWithoutSig = vanity;
	}

	// Determine difficulty (INTURN or NOTURN)
	const inTurn = await cliqueSignerInTurn(
		client.clique,
		client.minerAddress,
		block.header.number,
	);
	const difficulty = inTurn ? CLIQUE_DIFF_INTURN : CLIQUE_DIFF_NOTURN;

	// Update header with difficulty and extraData (without signature)
	const headerWithoutSig = {
		...block.header,
		difficulty,
		extraData: extraDataWithoutSig,
	};

	// Sign the header (headerWithoutSig already has extraData set correctly)
	const signedHeader = signCliqueHeader(headerWithoutSig, minerPrivateKey);

	console.log(
		`Signed Clique block #${block.header.number} (${inTurn ? "INTURN" : "NOTURN"})`,
	);

	return createBlock(signedHeader, block.transactions);
}

export function mineHeader(block: Block, difficulty: bigint): Block | null {
	// Calculate target from difficulty
	// Difficulty = 2^256 / (target + 1)
	// Target = (2^256 / difficulty) - 1
	const maxUint256 = BigInt(
		"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	);

	// For very low difficulty, use a simpler target calculation
	let target: bigint;
	if (difficulty <= 1n) {
		// With difficulty 1, almost any hash works (target is maxUint256)
		target = maxUint256;
	} else {
		target = maxUint256 / difficulty;
	}

	let nonce = 0n;
	const maxAttempts = 1000000n; // Limit attempts for demo
	const logInterval = 100000n; // Log progress every 100k attempts

	const header = { ...block.header };

	console.log(
		`Mining block #${block.header.number}, difficulty: ${difficulty}, target: 0x${target.toString(16).slice(0, 16)}...`,
	);

	while (nonce < maxAttempts) {
		header.nonce = nonce;
		const testBlock = createBlock(header, block.transactions);
		const hash = blockHash(testBlock);
		const hashValue = BigInt(`0x${hash.slice(2)}`);

		// Log progress periodically
		if (nonce > 0n && nonce % logInterval === 0n) {
			console.log(
				`Mining attempt ${nonce}, current hash: ${hash.slice(0, 20)}..., hashValue: 0x${hashValue.toString(16).slice(0, 16)}...`,
			);
		}

		// Check if hash meets target
		if (hashValue <= target) {
			console.log(`✓ Found valid nonce: ${nonce} after ${nonce + 1n} attempts`);
			console.log(`  Block hash: ${hash}`);
			return testBlock;
		}

		nonce++;
	}

	console.log(`✗ Mining failed after ${maxAttempts} attempts`);
	return null; // Mining failed
}

export function validateMinedBlock(block: Block, difficulty: bigint): boolean {
	const hash = blockHash(block);
	const hashValue = BigInt(`0x${hash.slice(2)}`);
	const maxUint256 = BigInt(
		"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	);
	const target = maxUint256 / difficulty;
	return hashValue <= target;
}

// Calculate difficulty adjustment based on block time
// Ethereum-style: adjust difficulty based on time between blocks
// Target: 15 seconds per block
function calculateDifficulty(parent: Block, timestamp: bigint): bigint {
	const TARGET_BLOCK_TIME = 15n; // seconds
	const DIFFICULTY_ADJUSTMENT_DENOMINATOR = 2048n; // 1/2048 adjustment per second

	const parentDifficulty = parent.header.difficulty;
	const parentTimestamp = parent.header.timestamp;
	const timeDelta = timestamp - parentTimestamp;

	let newDifficulty = parentDifficulty;

	if (timeDelta < TARGET_BLOCK_TIME) {
		// Block mined too fast - increase difficulty
		const adjustment =
			(parentDifficulty / DIFFICULTY_ADJUSTMENT_DENOMINATOR) *
			(TARGET_BLOCK_TIME - timeDelta);
		newDifficulty = parentDifficulty + adjustment;
	} else {
		// Block mined too slow - decrease difficulty
		const adjustment =
			(parentDifficulty / DIFFICULTY_ADJUSTMENT_DENOMINATOR) *
			(timeDelta - TARGET_BLOCK_TIME);
		newDifficulty =
			parentDifficulty > adjustment ? parentDifficulty - adjustment : 1n;
	}

	// Minimum difficulty
	if (newDifficulty < 1n) {
		newDifficulty = 1n;
	}

	return newDifficulty;
}

// Adjust gas limit based on parent usage
// Target: 50% gas usage
function adjustGasLimit(parentGasLimit: bigint, parentGasUsed: bigint): bigint {
	const TARGET_USAGE = 50n; // 50%
	const MAX_ADJUSTMENT = 1024n; // Max change per block

	const usagePercent = (parentGasUsed * 100n) / parentGasLimit;
	const adjustment =
		((parentGasLimit / MAX_ADJUSTMENT) * (usagePercent - TARGET_USAGE)) /
		TARGET_USAGE;

	let newGasLimit = parentGasLimit + adjustment;

	// Minimum gas limit
	const MIN_GAS_LIMIT = 5000n;
	if (newGasLimit < MIN_GAS_LIMIT) {
		newGasLimit = MIN_GAS_LIMIT;
	}

	return newGasLimit;
}
