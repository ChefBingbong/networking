// src/blockchain/p2p/tx-pool.ts
import type { Transaction, Hash } from "../types";
import { txHash } from "../utils";
import { validateTransaction } from "../tx/transaction";
import type { StateManagerState } from "../state/state-manager";

export interface TxPoolState {
	pending: Map<Hash, Transaction>;
	queued: Map<Hash, Transaction>;
}

export function createTxPool(): TxPoolState {
	return {
		pending: new Map(),
		queued: new Map(),
	};
}

export function addTransaction(
	pool: TxPoolState,
	tx: Transaction,
	stateManager: StateManagerState,
): boolean {
	const hash = txHash(tx);

	// Check if already exists
	if (pool.pending.has(hash) || pool.queued.has(hash)) {
		return false;
	}

	// Validate transaction
	if (!validateTransaction(tx, stateManager)) {
		return false;
	}

	// Add to pending
	pool.pending.set(hash, tx);
	return true;
}

export function removeTransaction(pool: TxPoolState, hash: Hash): boolean {
	const removed = pool.pending.delete(hash) || pool.queued.delete(hash);
	return removed;
}

export function getPendingTransactions(pool: TxPoolState): Transaction[] {
	return Array.from(pool.pending.values());
}

export function getQueuedTransactions(pool: TxPoolState): Transaction[] {
	return Array.from(pool.queued.values());
}

