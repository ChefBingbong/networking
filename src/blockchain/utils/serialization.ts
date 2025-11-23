// src/blockchain/utils/serialization.ts
import { parseWithBigInt, stringifyWithBigInt } from "../../utils/utils";
import type { Address, Block, BlockHeader, Hash, Transaction } from "../types";

/**
 * Convert Uint8Array to JSON-compatible format
 */
function uint8ArrayToJson(arr: Uint8Array): {
	type: "Uint8Array";
	data: number[];
} {
	return {
		type: "Uint8Array",
		data: Array.from(arr),
	};
}

/**
 * Convert JSON-compatible format back to Uint8Array
 */
function jsonToUint8Array(obj: {
	type: "Uint8Array";
	data: number[];
}): Uint8Array {
	return Uint8Array.from(obj.data);
}

/**
 * Serialize a block to JSON string (handles BigInt and Uint8Array conversion)
 */
export function serializeBlock(block: Block): string {
	const seen = new WeakSet<object>();
	const replacer = (_key: string, val: unknown): unknown => {
		if (typeof val === "bigint") return val.toString();
		if (val instanceof Uint8Array) {
			return uint8ArrayToJson(val);
		}
		if (typeof val === "object" && val !== null) {
			if (seen.has(val as object)) return undefined; // drop circular refs
			seen.add(val as object);
		}
		return val as unknown;
	};
	return JSON.stringify(block, replacer);
}

/**
 * Deserialize a block from JSON string (handles BigInt and Uint8Array conversion)
 * Manually reconstructs the block structure similar to createHeader
 */
export function deserializeBlock(json: string): Block {
	const parsed = JSON.parse(json);

	// Reconstruct header
	const header: BlockHeader = {
		parentHash: parsed.header.parentHash as Hash,
		ommersHash: parsed.header.ommersHash as Hash,
		beneficiary: parsed.header.beneficiary as Address,
		stateRoot: parsed.header.stateRoot as Hash,
		transactionsRoot: parsed.header.transactionsRoot as Hash,
		receiptsRoot: parsed.header.receiptsRoot as Hash,
		logsBloom: deserializeUint8Array(parsed.header.logsBloom),
		difficulty: deserializeBigInt(parsed.header.difficulty),
		number: deserializeBigInt(parsed.header.number),
		gasLimit: deserializeBigInt(parsed.header.gasLimit),
		gasUsed: deserializeBigInt(parsed.header.gasUsed),
		timestamp: deserializeBigInt(parsed.header.timestamp),
		extraData: deserializeUint8Array(parsed.header.extraData),
		mixHash: parsed.header.mixHash as Hash,
		nonce: deserializeBigInt(parsed.header.nonce),
	};

	// Reconstruct transactions
	const transactions: Transaction[] = (parsed.transactions || []).map(
		(tx: any) => deserializeTransactionFromObject(tx),
	);

	// Reconstruct ommers if present
	const ommers: BlockHeader[] | undefined = parsed.ommers
		? parsed.ommers.map((ommer: any) => ({
				parentHash: ommer.parentHash as Hash,
				ommersHash: ommer.ommersHash as Hash,
				beneficiary: ommer.beneficiary as Address,
				stateRoot: ommer.stateRoot as Hash,
				transactionsRoot: ommer.transactionsRoot as Hash,
				receiptsRoot: ommer.receiptsRoot as Hash,
				logsBloom: deserializeUint8Array(ommer.logsBloom),
				difficulty: deserializeBigInt(ommer.difficulty),
				number: deserializeBigInt(ommer.number),
				gasLimit: deserializeBigInt(ommer.gasLimit),
				gasUsed: deserializeBigInt(ommer.gasUsed),
				timestamp: deserializeBigInt(ommer.timestamp),
				extraData: deserializeUint8Array(ommer.extraData),
				mixHash: ommer.mixHash as Hash,
				nonce: deserializeBigInt(ommer.nonce),
			}))
		: undefined;

	return {
		header,
		transactions,
		ommers,
	};
}

/**
 * Helper to deserialize BigInt from JSON (string or number)
 */
function deserializeBigInt(value: string | number | bigint): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "string") return BigInt(value);
	if (typeof value === "number") return BigInt(value);
	return BigInt(0);
}

/**
 * Helper to deserialize Uint8Array from JSON
 */
function deserializeUint8Array(value: any): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "Uint8Array" &&
		"data" in value &&
		Array.isArray(value.data)
	) {
		return jsonToUint8Array(value as { type: "Uint8Array"; data: number[] });
	}
	if (Array.isArray(value)) {
		return Uint8Array.from(value);
	}
	return new Uint8Array(0);
}

/**
 * Helper to deserialize a transaction from parsed JSON object
 */
function deserializeTransactionFromObject(tx: any): Transaction {
	if (tx.type === "eip1559") {
		return {
			type: "eip1559",
			chainId: deserializeBigInt(tx.chainId),
			nonce: deserializeBigInt(tx.nonce),
			maxPriorityFeePerGas: deserializeBigInt(tx.maxPriorityFeePerGas),
			maxFeePerGas: deserializeBigInt(tx.maxFeePerGas),
			gasLimit: deserializeBigInt(tx.gasLimit),
			to: tx.to as Address | undefined,
			value: deserializeBigInt(tx.value),
			data: deserializeUint8Array(tx.data),
			v: deserializeBigInt(tx.v),
			r: deserializeBigInt(tx.r),
			s: deserializeBigInt(tx.s),
		};
	}

	// Legacy transaction
	return {
		type: "legacy",
		nonce: deserializeBigInt(tx.nonce),
		gasPrice: deserializeBigInt(tx.gasPrice),
		gasLimit: deserializeBigInt(tx.gasLimit),
		to: tx.to as Address | undefined,
		value: deserializeBigInt(tx.value),
		data: deserializeUint8Array(tx.data),
		v: deserializeBigInt(tx.v),
		r: deserializeBigInt(tx.r),
		s: deserializeBigInt(tx.s),
		chainId: tx.chainId ? deserializeBigInt(tx.chainId) : undefined,
	};
}

/**
 * Serialize a block header to JSON string
 */
export function serializeBlockHeader(header: BlockHeader): string {
	return stringifyWithBigInt(header);
}

/**
 * Deserialize a block header from JSON string
 */
export function deserializeBlockHeader(json: string): BlockHeader {
	return parseWithBigInt(json) as BlockHeader;
}

/**
 * Serialize a transaction to JSON string
 */
export function serializeTransaction(tx: Transaction): string {
	return stringifyWithBigInt(tx);
}

/**
 * Deserialize a transaction from JSON string
 */
export function deserializeTransaction(json: string): Transaction {
	return parseWithBigInt(json) as Transaction;
}

/**
 * Serialize an array of blocks to JSON string
 */
export function serializeBlocks(blocks: Block[]): string {
	const seen = new WeakSet<object>();
	const replacer = (_key: string, val: unknown): unknown => {
		if (typeof val === "bigint") return val.toString();
		if (val instanceof Uint8Array) {
			return uint8ArrayToJson(val);
		}
		if (typeof val === "object" && val !== null) {
			if (seen.has(val as object)) return undefined; // drop circular refs
			seen.add(val as object);
		}
		return val as unknown;
	};
	return JSON.stringify(blocks, replacer);
}

/**
 * Deserialize an array of blocks from JSON string
 */
export function deserializeBlocks(json: string): Block[] {
	const parsed = JSON.parse(json);
	if (!Array.isArray(parsed)) {
		throw new Error("Expected array of blocks");
	}
	return parsed.map((blockJson) => {
		// Reconstruct header
		const header: BlockHeader = {
			parentHash: blockJson.header.parentHash as Hash,
			ommersHash: blockJson.header.ommersHash as Hash,
			beneficiary: blockJson.header.beneficiary as Address,
			stateRoot: blockJson.header.stateRoot as Hash,
			transactionsRoot: blockJson.header.transactionsRoot as Hash,
			receiptsRoot: blockJson.header.receiptsRoot as Hash,
			logsBloom: deserializeUint8Array(blockJson.header.logsBloom),
			difficulty: deserializeBigInt(blockJson.header.difficulty),
			number: deserializeBigInt(blockJson.header.number),
			gasLimit: deserializeBigInt(blockJson.header.gasLimit),
			gasUsed: deserializeBigInt(blockJson.header.gasUsed),
			timestamp: deserializeBigInt(blockJson.header.timestamp),
			extraData: deserializeUint8Array(blockJson.header.extraData),
			mixHash: blockJson.header.mixHash as Hash,
			nonce: deserializeBigInt(blockJson.header.nonce),
		};

		// Reconstruct transactions
		const transactions: Transaction[] = (blockJson.transactions || []).map(
			(tx: any) => deserializeTransactionFromObject(tx),
		);

		// Reconstruct ommers if present
		const ommers: BlockHeader[] | undefined = blockJson.ommers
			? blockJson.ommers.map((ommer: any) => ({
					parentHash: ommer.parentHash as Hash,
					ommersHash: ommer.ommersHash as Hash,
					beneficiary: ommer.beneficiary as Address,
					stateRoot: ommer.stateRoot as Hash,
					transactionsRoot: ommer.transactionsRoot as Hash,
					receiptsRoot: ommer.receiptsRoot as Hash,
					logsBloom: deserializeUint8Array(ommer.logsBloom),
					difficulty: deserializeBigInt(ommer.difficulty),
					number: deserializeBigInt(ommer.number),
					gasLimit: deserializeBigInt(ommer.gasLimit),
					gasUsed: deserializeBigInt(ommer.gasUsed),
					timestamp: deserializeBigInt(ommer.timestamp),
					extraData: deserializeUint8Array(ommer.extraData),
					mixHash: ommer.mixHash as Hash,
					nonce: deserializeBigInt(ommer.nonce),
				}))
			: undefined;

		return {
			header,
			transactions,
			ommers,
		};
	});
}

/**
 * Serialize an array of transactions to JSON string
 */
export function serializeTransactions(txs: Transaction[]): string {
	return stringifyWithBigInt(txs);
}

/**
 * Deserialize an array of transactions from JSON string
 */
export function deserializeTransactions(json: string): Transaction[] {
	return parseWithBigInt(json) as Transaction[];
}
