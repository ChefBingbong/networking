// src/blockchain/blockchain/processor.ts

import { blockHash } from "../block/block";
import { type EVMResult, type EVMState, evmExecute } from "../evm/evm";
import type { StateManagerState } from "../state/state-manager";
import {
	calculateStateRoot,
	checkpoint,
	commit,
	getAccount,
	revertToCheckpoint,
} from "../state/state-manager";
import { createReceipt } from "../tx/receipt";
import { recoverSender } from "../tx/transaction";
import type {
	Address,
	Block,
	Hash,
	Log,
	Transaction,
	TransactionReceipt,
} from "../types";
import { hashToHex, keccak256Hash, txHash } from "../utils";
import { merkleRoot } from "../utils/merkle";
import type { ChainState } from "./chain";

export interface ProcessBlockResult {
	success: boolean;
	receipts: TransactionReceipt[];
	gasUsed: bigint;
}

export function processBlock(
	chain: ChainState,
	block: Block,
	stateManager: StateManagerState,
): ProcessBlockResult {
	const receipts: TransactionReceipt[] = [];
	let cumulativeGasUsed = 0n;

	checkpoint(stateManager);

	try {
		for (let i = 0; i < block.transactions.length; i++) {
			const tx = block.transactions[i]!;
			console.log(
				`Processing transaction ${i}: ${txHash(tx)}, value: ${tx.value.toString()}`,
			);
			const result = processTransaction(chain, tx, block, stateManager, i);

			if (!result.success) {
				console.log(`Transaction ${i} failed`);
				revertToCheckpoint(stateManager);
				return {
					success: false,
					receipts: [],
					gasUsed: cumulativeGasUsed,
				};
			}

			console.log(
				`Transaction ${i} succeeded, gasUsed: ${result.gasUsed.toString()}`,
			);
			receipts.push(result.receipt);
			cumulativeGasUsed += result.gasUsed;
		}

		// Calculate state root
		const stateRoot = calculateStateRoot(stateManager);

		// Validate state root matches block header (skip if state root is zero/placeholder)
		const isPlaceholder =
			block.header.stateRoot ===
			"0x0000000000000000000000000000000000000000000000000000000000000000";
		if (!isPlaceholder && stateRoot !== block.header.stateRoot) {
			revertToCheckpoint(stateManager);
			return {
				success: false,
				receipts: [],
				gasUsed: cumulativeGasUsed,
			};
		}

		commit(stateManager);

		console.log(
			`[processBlock] Committed state, processed ${receipts.length} transactions, total gasUsed: ${cumulativeGasUsed.toString()}`,
		);

		return {
			success: true,
			receipts,
			gasUsed: cumulativeGasUsed,
		};
	} catch (error) {
		revertToCheckpoint(stateManager);
		return {
			success: false,
			receipts: [],
			gasUsed: cumulativeGasUsed,
		};
	}
}

export function processTransaction(
	chain: ChainState,
	tx: Transaction,
	block: Block,
	stateManager: StateManagerState,
	txIndex: number,
): { success: boolean; receipt: TransactionReceipt; gasUsed: bigint } {
	console.log(
		`[processTransaction] Starting transaction ${txIndex} from ${txHash(tx)}`,
	);
	checkpoint(stateManager);

	try {
		// Recover sender
		const from = recoverSender(tx);
		if (!from) {
			console.log(`[processTransaction] Failed to recover sender`);
			throw new Error("Invalid transaction signature");
		}
		console.log(`[processTransaction] Recovered sender: ${from}`);

		// Validate transaction
		const senderAccount = getAccount(stateManager, from);
		console.log(
			`[processTransaction] Sender account - nonce: ${senderAccount.nonce.toString()}, balance: ${senderAccount.balance.toString()}, tx nonce: ${tx.nonce.toString()}`,
		);

		if (senderAccount.nonce !== tx.nonce) {
			console.log(
				`[processTransaction] Invalid nonce: account nonce ${senderAccount.nonce.toString()} !== tx nonce ${tx.nonce.toString()}`,
			);
			throw new Error("Invalid nonce");
		}

		// Create EVM state
		const evmState: EVMState = {
			stateManager,
			block,
			tx,
			gasUsed: 0n,
			logs: [],
			returnData: new Uint8Array(0),
		};

		// Execute transaction
		console.log(`[processTransaction] Executing transaction via EVM`);
		const result: EVMResult = evmExecute(evmState, tx, from);

		if (!result.success) {
			console.log(
				`[processTransaction] Transaction execution failed, reverting checkpoint`,
			);
			revertToCheckpoint(stateManager);
			return {
				success: false,
				receipt: createReceipt(
					0, // failed
					result.gasUsed,
					new Uint8Array(256).fill(0),
					result.logs,
					txHash(tx),
					txIndex,
					blockHash(block),
					block.header.number,
					from,
					tx.to,
					undefined,
					result.gasUsed,
				),
				gasUsed: result.gasUsed,
			};
		}

		console.log(
			`[processTransaction] Transaction execution succeeded, gasUsed: ${result.gasUsed.toString()}`,
		);

		// Create receipt
		const receipt = createReceipt(
			1, // success
			result.gasUsed,
			calculateLogsBloom(result.logs),
			result.logs,
			txHash(tx),
			txIndex,
			blockHash(block),
			block.header.number,
			from,
			tx.to,
			tx.to ? undefined : recoverContractAddress(from, senderAccount.nonce),
			result.gasUsed,
		);

		console.log(`[processTransaction] Committing state changes`);
		commit(stateManager);

		// Debug: Check balances after commit
		const fromAccAfter = getAccount(stateManager, from);
		const toAccAfter = tx.to ? getAccount(stateManager, tx.to) : null;
		console.log(
			`[processTransaction] After commit - From balance: ${fromAccAfter.balance.toString()}, To balance: ${toAccAfter?.balance.toString() ?? "N/A"}, From nonce: ${fromAccAfter.nonce.toString()}`,
		);

		return {
			success: true,
			receipt,
			gasUsed: result.gasUsed,
		};
	} catch (error) {
		console.log(`[processTransaction] Exception occurred:`, error);
		revertToCheckpoint(stateManager);
		return {
			success: false,
			receipt: createReceipt(
				0,
				0n,
				new Uint8Array(256).fill(0),
				[],
				txHash(tx),
				txIndex,
				blockHash(block),
				block.header.number,
				"0x0000000000000000000000000000000000000000",
				tx.to,
				undefined,
				0n,
			),
			gasUsed: 0n,
		};
	}
}

export function runBlock(
	chain: ChainState,
	block: Block,
	stateManager: StateManagerState,
): ProcessBlockResult {
	return processBlock(chain, block, stateManager);
}

export function runTx(
	chain: ChainState,
	tx: Transaction,
	block: Block,
	stateManager: StateManagerState,
): { success: boolean; receipt: TransactionReceipt; gasUsed: bigint } {
	return processTransaction(chain, tx, block, stateManager, 0);
}

export function calculateReceiptsRoot(receipts: TransactionReceipt[]): Hash {
	const leaves = receipts.map((r) => {
		// RLP encode receipt for Merkle tree
		const receiptData = new TextEncoder().encode(
			`${r.status}:${r.cumulativeGasUsed}:${r.transactionHash}:${r.blockHash}:${r.blockNumber}`,
		);
		return receiptData;
	});
	return merkleRoot(leaves);
}

export function calculateTransactionsRoot(txs: Transaction[]): Hash {
	if (txs.length === 0) {
		return "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash;
	}
	const leaves = txs.map((tx) => {
		// RLP encode transaction for Merkle tree
		const txData = new TextEncoder().encode(
			`${tx.nonce}:${tx.gasLimit}:${tx.to ?? ""}:${tx.value}`,
		);
		return txData;
	});
	return merkleRoot(leaves);
}

function calculateLogsBloom(logs: Log[]): Uint8Array {
	const bloom = new Uint8Array(256).fill(0);
	for (const log of logs) {
		// Simplified bloom filter - would use proper bloom filter in production
		const addressHash = keccak256Hash(new TextEncoder().encode(log.address));
		for (let i = 0; i < 3; i++) {
			const bit = addressHash[i]! % (256 * 8);
			bloom[Math.floor(bit / 8)] |= 1 << (bit % 8);
		}
		for (const topic of log.topics) {
			const topicHash = keccak256Hash(new TextEncoder().encode(topic));
			for (let i = 0; i < 3; i++) {
				const bit = topicHash[i]! % (256 * 8);
				bloom[Math.floor(bit / 8)] |= 1 << (bit % 8);
			}
		}
	}
	return bloom;
}

function recoverContractAddress(from: Address, nonce: bigint): Address {
	const rlp = new TextEncoder().encode(`${from}:${nonce}`);
	const hash = keccak256Hash(rlp);
	return hashToHex(hash.slice(-20)) as Address;
}
