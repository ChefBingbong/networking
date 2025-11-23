// src/blockchain/block/block.ts

import { calculateTransactionsRoot } from "../blockchain/processor";
import type {
	Block,
	BlockHeader,
	ChainConfig,
	Hash,
	Transaction,
} from "../types";
import {
	hashToHex,
	keccak256Hash,
	rlpDecode,
	rlpEncode,
	txFromArray,
	txToArray,
	blockHash as utilsBlockHash,
	validateBlockHeader,
} from "../utils";
import { headerFromArray, headerToArray } from "./header";

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
	// Use raw arrays (Ganache pattern) instead of pre-encoded bytes
	const headerArray = headerToArray(block.header);
	const txsArray = block.transactions.map((tx) => txToArray(tx));
	const ommersArray = block.ommers
		? block.ommers.map((ommer) => headerToArray(ommer))
		: [];
	// Single RLP encode of raw arrays
	return rlpEncode([headerArray, txsArray, ommersArray]);
}

export function blockFromRLP(data: Uint8Array): Block {
	const decoded = rlpDecode(data);

	if (!Array.isArray(decoded) || decoded.length < 2) {
		throw new Error("Invalid block RLP data");
	}

	// First element is header array (raw array of field values)
	const headerArray = decoded[0];
	if (!Array.isArray(headerArray)) {
		throw new Error("Invalid block header: expected array");
	}
	const header = headerFromArray(headerArray);

	// Second element is transactions array (array of transaction arrays)
	const txsArray = decoded[1];
	if (!Array.isArray(txsArray)) {
		throw new Error("Invalid transactions: expected array");
	}
	const transactions: Transaction[] = [];
	for (const txArray of txsArray) {
		if (Array.isArray(txArray)) {
			transactions.push(txFromArray(txArray));
		}
	}

	// Third element is ommers array (optional, array of ommer header arrays)
	let ommers: BlockHeader[] | undefined;
	if (decoded.length > 2 && decoded[2]) {
		const ommersArray = decoded[2];
		if (Array.isArray(ommersArray)) {
			ommers = [];
			for (const ommerArray of ommersArray) {
				if (Array.isArray(ommerArray)) {
					ommers.push(headerFromArray(ommerArray));
				}
			}
			if (ommers.length === 0) {
				ommers = undefined;
			}
		}
	}

	return createBlock(header, transactions, ommers);
}

export function getBlockHash(block: Block): Hash {
	return utilsBlockHash(block.header);
}

// Export blockHash as default for convenience
export { getBlockHash as blockHash };

export function validateBlock(
	block: Block,
	parent?: BlockHeader,
	_chainConfig?: ChainConfig,
): boolean {
	// Validate header
	if (!validateBlockHeader(block.header, parent)) {
		console.log(`[validateBlock] Header validation failed`);
		return false;
	}

	// Validate transactions root matches
	const calculatedRoot = calculateTransactionsRoot(block.transactions);
	if (calculatedRoot !== block.header.transactionsRoot) {
		console.log(
			`[validateBlock] Transactions root mismatch: calculated ${calculatedRoot}, expected ${block.header.transactionsRoot}`,
		);
		console.log(
			`[validateBlock] Block has ${block.transactions.length} transactions`,
		);
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
		console.log(
			`[validateBlock] Empty ommer hash mismatch: got ${block.header.ommersHash}`,
		);
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
