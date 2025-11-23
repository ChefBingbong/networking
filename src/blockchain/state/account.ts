// src/blockchain/state/account.ts
import type { AccountState, Hash } from "../types";
import {
	keccak256Hash,
	hashToHex,
	rlpEncode,
	rlpDecode,
	bigIntToBytes,
	bytesToBigInt,
	hexToBytes,
} from "../utils";

const EMPTY_CODE_HASH = hashToHex(
	keccak256Hash(new Uint8Array(0)),
) as Hash;

export function createAccount(): AccountState {
	return {
		nonce: 0n,
		balance: 0n,
		storageRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
		codeHash: EMPTY_CODE_HASH,
	};
}

export function accountToRLP(account: AccountState): Uint8Array {
	const nonceBytes = bigIntToBytes(account.nonce);
	const balanceBytes = bigIntToBytes(account.balance);
	const storageRootBytes = hexToBytes(account.storageRoot);
	const codeHashBytes = hexToBytes(account.codeHash);

	return rlpEncode([
		nonceBytes,
		balanceBytes,
		storageRootBytes,
		codeHashBytes,
	]);
}

export function accountFromRLP(data: Uint8Array): AccountState {
	// Simplified - full RLP decode would be needed
	// For now, assume we have the fields
	const decoded = rlpDecode(data) as Uint8Array[];
	if (!Array.isArray(decoded) || decoded.length < 4) {
		throw new Error("Invalid account RLP data");
	}

	return {
		nonce: bytesToBigInt(decoded[0]!),
		balance: bytesToBigInt(decoded[1]!),
		storageRoot: hashToHex(decoded[2]!),
		codeHash: hashToHex(decoded[3]!),
	};
}

export function isEmptyAccount(account: AccountState): boolean {
	return (
		account.nonce === 0n &&
		account.balance === 0n &&
		account.codeHash === EMPTY_CODE_HASH
	);
}

