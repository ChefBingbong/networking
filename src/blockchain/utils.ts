// src/blockchain/utils.ts
import { keccak256 } from "ethereum-cryptography/keccak";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { Address, Hash, BlockHeader, Transaction } from "./types";

/**
 * Hash functions
 */

export function keccak256Hash(data: Uint8Array): Uint8Array {
	return keccak256(data);
}

export function hashToHex(hash: Uint8Array): Hash {
	return `0x${Buffer.from(hash).toString("hex")}`;
}

export function hexToBytes(hex: string): Uint8Array {
	const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
	return Uint8Array.from(Buffer.from(cleanHex, "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
	return `0x${Buffer.from(bytes).toString("hex")}`;
}

/**
 * Address utilities
 */

export function addressFromPrivateKey(privateKey: Uint8Array): Address {
	const publicKey = secp256k1.getPublicKey(privateKey, true); // compressed
	const hash = keccak256Hash(publicKey.slice(1)); // remove 0x04 prefix
	return hashToHex(hash.slice(-20)); // last 20 bytes
}

export function addressFromPublicKey(publicKey: Uint8Array): Address {
	const hash = keccak256Hash(publicKey.slice(1)); // remove 0x04 prefix if present
	return hashToHex(hash.slice(-20)); // last 20 bytes
}

export function validateAddress(address: Address): boolean {
	if (!address.startsWith("0x")) return false;
	const clean = address.slice(2);
	if (clean.length !== 40) return false;
	return /^[0-9a-fA-F]{40}$/.test(clean);
}

/**
 * RLP encoding (simplified implementation)
 * For production, consider using a library like rlp-encode
 */

export function rlpEncode(input: unknown): Uint8Array {
	if (input instanceof Uint8Array) {
		if (input.length === 1 && input[0] < 0x80) {
			return input;
		}
		if (input.length < 56) {
			return Uint8Array.from([0x80 + input.length, ...input]);
		}
		const lenBytes = encodeLength(input.length, 0x80 + 56);
		return Uint8Array.from([...lenBytes, ...input]);
	}

	if (Array.isArray(input)) {
		const encoded = input.map((item) => rlpEncode(item));
		const totalLength = encoded.reduce((sum, e) => sum + e.length, 0);
		if (totalLength < 56) {
			return Uint8Array.from([0xc0 + totalLength, ...encoded.flat()]);
		}
		const lenBytes = encodeLength(totalLength, 0xc0 + 56);
		return Uint8Array.from([...lenBytes, ...encoded.flat()]);
	}

	throw new Error(`Unsupported RLP input type: ${typeof input}`);
}

function encodeLength(len: number, offset: number): Uint8Array {
	const hex = len.toString(16);
	const bytes = hex.length % 2 === 0 ? hex : `0${hex}`;
	const byteArray = Uint8Array.from(
		Buffer.from(bytes, "hex").toJSON().data as number[],
	);
	return Uint8Array.from([offset + byteArray.length, ...byteArray]);
}

export function rlpDecode(data: Uint8Array): unknown {
	if (data.length === 0) {
		return Uint8Array.of(0x80);
	}

	const firstByte = data[0]!;

	// Single byte
	if (firstByte < 0x80) {
		return Uint8Array.of(firstByte);
	}

	// String
	if (firstByte < 0xb8) {
		const len = firstByte - 0x80;
		if (len === 1 && data[1]! < 0x80) {
			return Uint8Array.of(data[1]!);
		}
		return data.slice(1, 1 + len);
	}

	// Long string
	if (firstByte < 0xc0) {
		const lenOfLen = firstByte - 0xb7;
		const len = parseInt(
			Buffer.from(data.slice(1, 1 + lenOfLen)).toString("hex"),
			16,
		);
		return data.slice(1 + lenOfLen, 1 + lenOfLen + len);
	}

	// List
	if (firstByte < 0xf8) {
		const len = firstByte - 0xc0;
		return decodeList(data.slice(1, 1 + len));
	}

	// Long list
	const lenOfLen = firstByte - 0xf7;
	const len = parseInt(
		Buffer.from(data.slice(1, 1 + lenOfLen)).toString("hex"),
		16,
	);
	return decodeList(data.slice(1 + lenOfLen, 1 + lenOfLen + len));
}

function decodeList(data: Uint8Array): unknown[] {
	const items: unknown[] = [];
	let offset = 0;

	while (offset < data.length) {
		const item = rlpDecode(data.slice(offset));
		items.push(item);
		if (item instanceof Uint8Array) {
			const encoded = rlpEncode(item);
			offset += encoded.length;
		} else if (Array.isArray(item)) {
			const encoded = rlpEncode(item);
			offset += encoded.length;
		} else {
			offset += 1;
		}
	}

	return items;
}

/**
 * Serialization utilities
 */

export function blockToRLP(block: BlockHeader): Uint8Array {
	// Simplified - full implementation would handle all header fields
	const fields = [
		hexToBytes(block.parentHash),
		hexToBytes(block.ommersHash),
		hexToBytes(block.beneficiary),
		hexToBytes(block.stateRoot),
		hexToBytes(block.transactionsRoot),
		hexToBytes(block.receiptsRoot),
		block.logsBloom,
		bigIntToBytes(block.difficulty),
		bigIntToBytes(block.number),
		bigIntToBytes(block.gasLimit),
		bigIntToBytes(block.gasUsed),
		bigIntToBytes(block.timestamp),
		block.extraData,
		hexToBytes(block.mixHash),
		bigIntToBytes(block.nonce),
	];
	return rlpEncode(fields);
}

export function txToRLP(tx: Transaction): Uint8Array {
	if (tx.type === "legacy") {
		// Check if this is an unsigned transaction (for signing)
		// EIP-155: unsigned tx with chainId is [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
		// Non-EIP-155: unsigned tx is [nonce, gasPrice, gasLimit, to, value, data]
		// Signed tx is always: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
		const isUnsigned = tx.v === 0n && tx.r === 0n && tx.s === 0n;
		
		if (isUnsigned && tx.chainId) {
			// EIP-155 unsigned transaction encoding
			const fields = [
				bigIntToBytes(tx.nonce),
				bigIntToBytes(tx.gasPrice),
				bigIntToBytes(tx.gasLimit),
				tx.to ? hexToBytes(tx.to) : Uint8Array.of(),
				bigIntToBytes(tx.value),
				tx.data,
				bigIntToBytes(tx.chainId),
				Uint8Array.of(0), // r = 0
				Uint8Array.of(0), // s = 0
			];
			return rlpEncode(fields);
		}
		
		if (isUnsigned && !tx.chainId) {
			// Non-EIP-155 unsigned transaction encoding
			const fields = [
				bigIntToBytes(tx.nonce),
				bigIntToBytes(tx.gasPrice),
				bigIntToBytes(tx.gasLimit),
				tx.to ? hexToBytes(tx.to) : Uint8Array.of(),
				bigIntToBytes(tx.value),
				tx.data,
			];
			return rlpEncode(fields);
		}
		
		// Signed transaction encoding
		const fields = [
			bigIntToBytes(tx.nonce),
			bigIntToBytes(tx.gasPrice),
			bigIntToBytes(tx.gasLimit),
			tx.to ? hexToBytes(tx.to) : Uint8Array.of(),
			bigIntToBytes(tx.value),
			tx.data,
			bigIntToBytes(tx.v),
			bigIntToBytes(tx.r),
			bigIntToBytes(tx.s),
		];
		return rlpEncode(fields);
	}

	// EIP1559
	const fields = [
		bigIntToBytes(tx.chainId),
		bigIntToBytes(tx.nonce),
		bigIntToBytes(tx.maxPriorityFeePerGas),
		bigIntToBytes(tx.maxFeePerGas),
		bigIntToBytes(tx.gasLimit),
		tx.to ? hexToBytes(tx.to) : Uint8Array.of(),
		bigIntToBytes(tx.value),
		tx.data,
		Uint8Array.of(), // access list (empty for now)
		bigIntToBytes(tx.v),
		bigIntToBytes(tx.r),
		bigIntToBytes(tx.s),
	];
	return rlpEncode(fields);
}

export function headerToRLP(header: BlockHeader): Uint8Array {
	return blockToRLP(header);
}

export function txHash(tx: Transaction): Hash {
	const rlp = txToRLP(tx);
	const hash = keccak256Hash(rlp);
	return hashToHex(hash);
}

/**
 * Validation utilities
 */

export function validateBlockHeader(
	header: BlockHeader,
	parent?: BlockHeader,
): boolean {
	if (!validateAddress(header.beneficiary)) {
		console.log(`[validateBlockHeader] Invalid beneficiary address: ${header.beneficiary}`);
		return false;
	}
	if (header.logsBloom.length !== 256) {
		console.log(`[validateBlockHeader] Invalid logsBloom length: ${header.logsBloom.length}`);
		return false;
	}
	if (header.number < 0n) {
		console.log(`[validateBlockHeader] Invalid block number: ${header.number.toString()}`);
		return false;
	}
	if (header.gasLimit <= 0n) {
		console.log(`[validateBlockHeader] Invalid gas limit: ${header.gasLimit.toString()}`);
		return false;
	}
	if (header.gasUsed > header.gasLimit) {
		console.log(`[validateBlockHeader] Gas used exceeds limit: ${header.gasUsed.toString()} > ${header.gasLimit.toString()}`);
		return false;
	}

	if (parent) {
		if (header.number !== parent.number + 1n) {
			console.log(`[validateBlockHeader] Block number not sequential: expected ${(parent.number + 1n).toString()}, got ${header.number.toString()}`);
			return false;
		}
		if (header.parentHash !== blockHash(parent)) {
			console.log(`[validateBlockHeader] Parent hash mismatch: expected ${blockHash(parent)}, got ${header.parentHash}`);
			return false;
		}
	}

	return true;
}

export function blockHash(header: BlockHeader): Hash {
	const encoded = headerToRLP(header);
	const hash = keccak256Hash(encoded);
	return hashToHex(hash);
}

/**
 * BigInt utilities
 */

export function bigIntToBytes(value: bigint): Uint8Array {
	if (value === 0n) {
		return Uint8Array.of(0);
	}
	const hex = value.toString(16);
	const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
	return hexToBytes(padded);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
	if (bytes.length === 0) return 0n;
	return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

export function padTo32Bytes(bytes: Uint8Array): Uint8Array {
	if (bytes.length === 32) return bytes;
	if (bytes.length > 32) {
		return bytes.slice(-32);
	}
	const padded = new Uint8Array(32);
	padded.set(bytes, 32 - bytes.length);
	return padded;
}

