// src/blockchain/block/block.ts
import type { Block, BlockHeader, Transaction, ChainConfig, Hash } from "../types";
import { createHeader, headerToRLP as headerRLP } from "./header";
import {
	blockHash as utilsBlockHash,
	validateBlockHeader,
	txToRLP,
	txHash as utilsTxHash,
} from "../utils";
import { keccak256Hash, hashToHex, rlpEncode } from "../utils";
import { merkleRoot } from "../utils/merkle";
import { calculateTransactionsRoot } from "../blockchain/processor";

export function createBlock(
	header: BlockHeader,
	txs: Transaction[],
	ommers?: BlockHeader[],
): Block {
	return {
		header,
		transactions: txs,
		ommers,
	};
}

export function blockToRLP(block: Block): Uint8Array {
	const headerRLPBytes = headerRLP(block.header);
	const txsRLP = block.transactions.map((tx) => txToRLP(tx));
	const ommersRLP = block.ommers
		? block.ommers.map((ommer) => headerRLP(ommer))
		: [];
	return rlpEncode([headerRLPBytes, txsRLP, ommersRLP]);
}

export function blockFromRLP(data: Uint8Array): Block {
	// Simplified - full RLP decode implementation needed
	throw new Error("blockFromRLP not fully implemented");
}

export function getBlockHash(block: Block): Hash {
	return utilsBlockHash(block.header);
}

// Export blockHash as default for convenience
export { getBlockHash as blockHash };

export function validateBlock(
	block: Block,
	parent?: BlockHeader,
	chainConfig?: ChainConfig,
): boolean {
	// Validate header
	if (!validateBlockHeader(block.header, parent)) {
		console.log(`[validateBlock] Header validation failed`);
		return false;
	}

	// Validate transactions root matches
	const calculatedRoot = calculateTransactionsRoot(block.transactions);
	if (calculatedRoot !== block.header.transactionsRoot) {
		console.log(`[validateBlock] Transactions root mismatch: calculated ${calculatedRoot}, expected ${block.header.transactionsRoot}`);
		console.log(`[validateBlock] Block has ${block.transactions.length} transactions`);
		return false;
	}

	// Validate ommers hash if present
	if (block.ommers && block.ommers.length > 0) {
		const calculatedOmmerHash = calculateOmmersHash(block.ommers);
		if (calculatedOmmerHash !== block.header.ommersHash) {
			console.log(`[validateBlock] Ommer hash mismatch`);
			return false;
		}
	} else if (
		block.header.ommersHash !==
		"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347"
	) {
		console.log(`[validateBlock] Empty ommer hash mismatch: got ${block.header.ommersHash}`);
		return false;
	}

	return true;
}

// Removed duplicate calculateTransactionsRoot - using the one from processor.ts

function calculateOmmersHash(ommers: BlockHeader[]): Hash {
	if (ommers.length === 0) {
		return "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347" as Hash;
	}
	// Simplified - would use Merkle tree in production
	const combined = new TextEncoder().encode(
		ommers.map((ommer) => utilsBlockHash(ommer)).join(""),
	);
	return hashToHex(keccak256Hash(combined)) as Hash;
}

