// src/blockchain/state/state-manager.ts
import type { AccountState, Address, Hash, StateSnapshot } from "../types";
import { hashToHex, keccak256Hash } from "../utils";
import { merkleRoot } from "../utils/merkle";
import { createAccount, isEmptyAccount } from "./account";

export interface StateManagerState {
	accounts: Map<Address, AccountState>;
	storage: Map<Address, Map<Hash, Hash>>;
	code: Map<Address, Uint8Array>;
	checkpoints: StateSnapshot[];
}

export function createStateManager(): StateManagerState {
	return {
		accounts: new Map(),
		storage: new Map(),
		code: new Map(),
		checkpoints: [],
	};
}

export function getAccount(
	state: StateManagerState,
	address: Address,
): AccountState {
	const account = state.accounts.get(address);
	if (account) {
		return account;
	}
	return createAccount();
}

export function putAccount(
	state: StateManagerState,
	address: Address,
	account: AccountState,
): void {
	if (isEmptyAccount(account)) {
		state.accounts.delete(address);
	} else {
		state.accounts.set(address, account);
	}
}

export function getContractStorage(
	state: StateManagerState,
	address: Address,
	key: Hash,
): Hash {
	const contractStorage = state.storage.get(address);
	if (!contractStorage) {
		return "0x0000000000000000000000000000000000000000000000000000000000000000";
	}
	return (
		contractStorage.get(key) ??
		"0x0000000000000000000000000000000000000000000000000000000000000000"
	);
}

export function putContractStorage(
	state: StateManagerState,
	address: Address,
	key: Hash,
	value: Hash,
): void {
	let contractStorage = state.storage.get(address);
	if (!contractStorage) {
		contractStorage = new Map();
		state.storage.set(address, contractStorage);
	}

	// If value is zero, delete the storage slot (EIP-1283 behavior)
	if (
		value ===
		"0x0000000000000000000000000000000000000000000000000000000000000000"
	) {
		contractStorage.delete(key);
	} else {
		contractStorage.set(key, value);
	}
}

export function getAccountCode(
	state: StateManagerState,
	address: Address,
): Uint8Array {
	return state.code.get(address) ?? new Uint8Array(0);
}

export function putAccountCode(
	state: StateManagerState,
	address: Address,
	code: Uint8Array,
): void {
	if (code.length === 0) {
		state.code.delete(address);
		// Update account codeHash to empty
		const account = getAccount(state, address);
		account.codeHash = hashToHex(keccak256Hash(new Uint8Array(0))) as Hash;
		putAccount(state, address, account);
	} else {
		state.code.set(address, code);
		// Update account codeHash
		const account = getAccount(state, address);
		account.codeHash = hashToHex(keccak256Hash(code)) as Hash;
		putAccount(state, address, account);
	}
}

export function checkpoint(state: StateManagerState): void {
	const snapshot: StateSnapshot = {
		accounts: new Map(state.accounts),
		storage: new Map(
			Array.from(state.storage.entries()).map(([addr, storage]) => [
				addr,
				new Map(storage),
			]),
		),
		code: new Map(state.code),
	};
	state.checkpoints.push(snapshot);
	console.log(
		`[checkpoint] Created checkpoint ${state.checkpoints.length}, accounts: ${state.accounts.size}`,
	);
}

export function revertToCheckpoint(state: StateManagerState): void {
	const snapshot = state.checkpoints.pop();
	if (!snapshot) {
		console.log(`[revertToCheckpoint] No checkpoints to revert`);
		return; // Return silently instead of throwing - allows graceful handling
	}

	const checkpointCount = state.checkpoints.length;
	state.accounts = snapshot.accounts;
	state.storage = snapshot.storage;
	state.code = snapshot.code;
	console.log(
		`[revertToCheckpoint] Reverted to checkpoint ${checkpointCount}, accounts: ${state.accounts.size}`,
	);
}

export function commit(state: StateManagerState): void {
	const checkpointCount = state.checkpoints.length;
	// Clear all checkpoints on commit
	state.checkpoints = [];
	console.log(
		`[commit] Committed ${checkpointCount} checkpoint(s), accounts: ${state.accounts.size}`,
	);
}

export function calculateStateRoot(state: StateManagerState): Hash {
	if (state.accounts.size === 0) {
		return "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash;
	}

	// Create account leaves for Merkle tree
	const accountLeaves: Uint8Array[] = [];
	for (const [address, account] of state.accounts.entries()) {
		const accountData = new TextEncoder().encode(
			`${address}:${account.nonce}:${account.balance}:${account.codeHash}`,
		);
		accountLeaves.push(accountData);
	}

	return merkleRoot(accountLeaves);
}
