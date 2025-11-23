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
	txFromRLP,
	txToRLP,
	blockHash as utilsBlockHash,
	validateBlockHeader,
} from "../utils";
import { headerFromRLP, headerToRLP as headerRLP } from "./header";

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
	const decoded = rlpDecode(data);

	if (!Array.isArray(decoded) || decoded.length < 2) {
		throw new Error("Invalid block RLP data");
	}

	// First element is header RLP (as Uint8Array)
	console.log(decoded, "decoded");
	const headerRLP = decoded[0];
	if (!(headerRLP instanceof Uint8Array)) {
		console.error(
			"[blockFromRLP] Header RLP is not Uint8Array:",
			typeof headerRLP,
			headerRLP,
		);
		throw new Error("Invalid block header RLP: not Uint8Array");
	}
	console.log(
		`[blockFromRLP] Decoding header RLP, length: ${headerRLP.length}`,
	);
	const header = headerFromRLP(headerRLP);

	// Second element is transactions array (array of RLP-encoded transactions)
	const txsRLP = decoded[1];
	if (!Array.isArray(txsRLP)) {
		throw new Error("Invalid transactions RLP");
	}
	const transactions: Transaction[] = [];
	for (const txRLP of txsRLP) {
		if (txRLP instanceof Uint8Array) {
			transactions.push(txFromRLP(txRLP));
		}
	}

	// Third element is ommers array (optional, array of RLP-encoded headers)
	let ommers: BlockHeader[] | undefined;
	if (decoded.length > 2 && decoded[2]) {
		const ommersRLP = decoded[2];
		if (Array.isArray(ommersRLP)) {
			ommers = [];
			for (const ommerRLP of ommersRLP) {
				if (ommerRLP instanceof Uint8Array) {
					ommers.push(headerFromRLP(ommerRLP));
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
