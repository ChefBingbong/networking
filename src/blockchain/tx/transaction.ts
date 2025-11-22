// src/blockchain/tx/transaction.ts

import { secp256k1 } from "@noble/curves/secp256k1";
import type { StateManagerState } from "../state/state-manager";
import { getAccount } from "../state/state-manager";
import type {
	Address,
	EIP1559Transaction,
	LegacyTransaction,
	Transaction,
} from "../types";
import { hashToHex, keccak256Hash, txToRLP, validateAddress } from "../utils";

export function createTransaction(
	fields: Partial<Transaction> & {
		type: "legacy" | "eip1559";
		gasLimit: bigint;
		value: bigint;
		data: Uint8Array;
	},
): Transaction {
	if (fields.type === "legacy") {
		return {
			type: "legacy",
			nonce: fields.nonce ?? 0n,
			gasPrice: fields.gasPrice ?? 0n,
			gasLimit: fields.gasLimit,
			to: fields.to,
			value: fields.value,
			data: fields.data,
			v: fields.v ?? 0n,
			r: fields.r ?? 0n,
			s: fields.s ?? 0n,
			chainId: fields.chainId,
		} as LegacyTransaction;
	} else {
		return {
			type: "eip1559",
			nonce: fields.nonce ?? 0n,
			maxFeePerGas: fields.maxFeePerGas ?? 0n,
			maxPriorityFeePerGas: fields.maxPriorityFeePerGas ?? 0n,
			gasLimit: fields.gasLimit,
			to: fields.to,
			value: fields.value,
			data: fields.data,
			v: fields.v ?? 0n,
			r: fields.r ?? 0n,
			s: fields.s ?? 0n,
			chainId: fields.chainId ?? 1n,
		} as EIP1559Transaction;
	}
}

export function signTransaction(
	tx: Transaction,
	privateKey: Uint8Array,
): Transaction {
	// Create unsigned transaction (v, r, s = 0 for signing)
	const unsignedTx = { ...tx, v: 0n, r: 0n, s: 0n };

	// RLP encode unsigned transaction (will use EIP-155 encoding if chainId present)
	const rlp = txToRLP(unsignedTx);

	// Hash the RLP with keccak256 (Ethereum standard)
	const hash = keccak256Hash(rlp);

	// Sign the hash directly with secp256k1 (like cert.ts pattern)
	const signature = secp256k1.sign(hash, privateKey);

	// Extract r, s, recovery bit
	const r = signature.r;
	const s = signature.s;
	const recovery = signature.recovery ?? 0;

	// Calculate v based on chainId (EIP-155)
	let v: bigint;
	if (tx.type === "legacy" && tx.chainId) {
		// EIP-155: v = recovery + chainId * 2 + 35
		v = BigInt(recovery) + tx.chainId * 2n + 35n;
	} else {
		// Standard: v = recovery + 27
		v = BigInt(recovery + 27);
	}

	return {
		...tx,
		v,
		r,
		s,
	};
}

export function recoverSender(tx: Transaction): Address | null {
	try {
		// Create unsigned transaction (same as in signTransaction)
		const unsignedTx = { ...tx, v: 0n, r: 0n, s: 0n };

		// RLP encode unsigned transaction (must match signTransaction)
		const rlp = txToRLP(unsignedTx);

		// Hash with keccak256 (must match signTransaction)
		const hash = keccak256Hash(rlp);

		// Extract recovery bit from v
		let v = Number(tx.v);

		if (tx.type === "legacy" && tx.chainId) {
			// EIP-155: v = recovery + chainId * 2 + 35
			// So recovery = v - chainId * 2 - 35
			// v = v;
			v = v - Number(tx.chainId) * 2 - 35;
		}

		const recovery = v;

		// Convert r and s bigints to bytes (32 bytes each, big-endian)
		const rBytes = new Uint8Array(32);
		const sBytes = new Uint8Array(32);

		let rValue = tx.r;
		let sValue = tx.s;
		for (let i = 31; i >= 0; i--) {
			rBytes[i] = Number(rValue & 0xffn);
			sBytes[i] = Number(sValue & 0xffn);
			rValue = rValue >> 8n;
			sValue = sValue >> 8n;
		}

		// Create compact signature (64 bytes: 32 bytes r + 32 bytes s)
		const compactSig = new Uint8Array(64);
		compactSig.set(rBytes, 0);
		compactSig.set(sBytes, 32);

		// Recover public key (like cert.ts pattern)
		const signatureObj =
			secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recovery);
		const recoveredPubKey = signatureObj.recoverPublicKey(hash);

		// Get uncompressed public key
		const publicKey = recoveredPubKey.toRawBytes(true);

		// Derive address: keccak256(publicKey[1:])[12:]
		// Remove first byte (0x04 for uncompressed) and take last 20 bytes
		const publicKeyWithoutPrefix = publicKey.slice(1);
		const addressHash = keccak256Hash(publicKeyWithoutPrefix);
		return hashToHex(addressHash.slice(-20)) as Address;
	} catch (error) {
		console.error("[recoverSender] Error:", error);
		return null;
	}
}

export function validateTransaction(
	tx: Transaction,
	stateManager: StateManagerState,
): boolean {
	// Recover sender
	const from = recoverSender(tx);
	if (!from) {
		return false;
	}

	// Validate address
	if (!validateAddress(from)) {
		return false;
	}

	// Check nonce
	const account = getAccount(stateManager, from);
	if (tx.nonce < account.nonce) {
		return false;
	}

	// Check balance for gas + value
	const gasPrice =
		tx.type === "legacy" ? (tx.gasPrice ?? 0n) : (tx.maxFeePerGas ?? 0n);
	const totalCost = tx.value + tx.gasLimit * gasPrice;
	if (account.balance < totalCost) {
		return false;
	}

	// Validate signature
	const recovered = recoverSender(tx);
	if (!recovered || recovered !== from) {
		return false;
	}

	return true;
}
