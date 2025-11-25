import { BIGINT_0 } from "../../utils/constants.ts";
import type { Address } from "../../utils/index.ts";

export interface AccountState {
	balance: bigint;
	nonce: bigint;
	codeHash: string;
	storageRoot: string;
}

export interface StateManager {
	accounts: Map<Address, AccountState>;
}

/**
 * Get account state
 */
export function getAccount(
	stateManager: StateManager,
	address: Address,
): AccountState {
	const account = stateManager.accounts.get(address);
	if (account) {
		return account;
	}
	return {
		balance: BIGINT_0,
		nonce: BIGINT_0,
		codeHash: "0x",
		storageRoot: "0x",
	};
}

/**
 * Put account state
 */
export function putAccount(
	stateManager: StateManager,
	address: Address,
	account: AccountState,
): void {
	stateManager.accounts.set(address, account);
}

/**
 * Update account balance
 */
export function updateBalance(
	stateManager: StateManager,
	address: Address,
	delta: bigint,
): void {
	const account = getAccount(stateManager, address);
	putAccount(stateManager, address, {
		...account,
		balance: account.balance + delta,
	});
}

/**
 * Increment account nonce
 */
export function incrementNonce(
	stateManager: StateManager,
	address: Address,
): void {
	const account = getAccount(stateManager, address);
	putAccount(stateManager, address, {
		...account,
		nonce: account.nonce + BigInt(1),
	});
}

