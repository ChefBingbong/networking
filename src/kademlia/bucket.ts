// src/kademlia/bucket.ts
import { EventEmitter } from "events";
import type { KadNodeInfo } from "./kademlia";
import type { BucketEventEmitter, KadEntry, KadEntryFull } from "./types";
import { EntryStatus, InsertResult, UpdateResult } from "./types";

/**
 * Per-bucket config.
 */
export const MAX_NODES_PER_BUCKET = 20; // your k value (you used 20 before)
export const PENDING_TIMEOUT_MS = 15_000; // tweakable

/**
 * One Kademlia bucket.
 *
 * - Entries ordered from least recently *connected* or *disconnected* to most.
 * - Maintains a "pending" entry when full to enable eviction of long-dead peers.
 */
export class Bucket extends (EventEmitter as { new (): BucketEventEmitter }) {
	/**
	 * Entries ordered from least-recently to most-recently connected.
	 *
	 * Invariant: [0, firstConnectedIndex)  = disconnected entries (LRU first)
	 *            [firstConnectedIndex, ..) = connected entries (LRU connected first)
	 */
	private nodes: KadEntry[];

	/**
	 * Index where connected entries start.
	 * undefined means "no connected entries".
	 */
	private firstConnectedIndex?: number;

	/**
	 * A node that is pending to be inserted into a full bucket, should the
	 * least-recently connected (and currently disconnected) node not be
	 * marked as connected within `pendingTimeout`.
	 */
	private pending: KadEntry | undefined;

	private pendingTimeoutMs: number;
	private pendingTimeoutId: NodeJS.Timeout | undefined;

	constructor(pendingTimeoutMs: number = PENDING_TIMEOUT_MS) {
		super();
		this.nodes = [];
		this.pendingTimeoutMs = pendingTimeoutMs;
	}

	// ---------- basic introspection ----------

	clear(): void {
		this.nodes = [];
		this.pending = undefined;
		if (this.pendingTimeoutId) {
			clearTimeout(this.pendingTimeoutId);
			this.pendingTimeoutId = undefined;
		}
		this.firstConnectedIndex = undefined;
	}

	size(): number {
		return this.nodes.length;
	}

	isEmpty(): boolean {
		return this.nodes.length === 0;
	}

	// ---------- insert / update ----------

	/**
	 * Attempt to add a node to the bucket with a given status.
	 *
	 * If status=Connected and bucket is full but there is at least one
	 * disconnected entry, we use "pending" logic (eviction candidate).
	 */
	add(value: KadNodeInfo, status: EntryStatus): InsertResult {
		// no duplicates
		if (this.get(value.id)) {
			return InsertResult.NodeExists;
		}

		const isPendingNode = this.pending && this.pending.value.id === value.id;

		switch (status) {
			case EntryStatus.Connected: {
				if (this.nodes.length < MAX_NODES_PER_BUCKET) {
					// first connected node index is either already set or becomes "old end"
					this.firstConnectedIndex =
						this.firstConnectedIndex ?? this.nodes.length;
					this.nodes.push({ value, status });
					break;
				} else {
					// bucket full, try pending
					if (this.addPending(value, status)) {
						return InsertResult.Pending;
					} else {
						return InsertResult.FailedBucketFull;
					}
				}
			}

			case EntryStatus.Disconnected: {
				if (this.nodes.length < MAX_NODES_PER_BUCKET) {
					if (this.firstConnectedIndex === undefined) {
						// no connected entries yet, append
						this.nodes.push({ value, status });
					} else {
						// insert before first connected
						this.nodes.splice(this.firstConnectedIndex, 0, {
							value,
							status,
						});
						this.firstConnectedIndex++;
					}
					break;
				} else {
					return InsertResult.FailedBucketFull;
				}
			}
		}

		if (isPendingNode) {
			this.pending = undefined;
		}
		return InsertResult.Inserted;
	}

	/**
	 * Update only the value (metadata) of an entry, if it exists.
	 * NOTE: we don’t re-order here; re-ordering is tied to status changes.
	 */
	updateValue(value: KadNodeInfo): UpdateResult {
		const node = this.nodes.find((e) => e.value.id === value.id);
		if (node) {
			// we don’t have seq numbers like ENR, just overwrite
			node.value = value;
			return UpdateResult.Updated;
		} else if (this.pending && this.pending.value.id === value.id) {
			this.pending.value = value;
			return UpdateResult.UpdatedPending;
		} else {
			return UpdateResult.FailedKeyNonExistent;
		}
	}

	/**
	 * Update status (Connected/Disconnected), reordering entry accordingly.
	 */
	updateStatus(id: string, status: EntryStatus): UpdateResult {
		const index = this.nodes.findIndex((e) => e.value.id === id);
		if (index !== -1) {
			const node = this.removeByIndex(index);
			const oldStatus = node.status;
			const notModified = oldStatus === status;
			const wasConnected = oldStatus === EntryStatus.Connected;
			const isConnected = status === EntryStatus.Connected;

			// If the LRU connected node reconnects, drop pending candidate
			if (index === 0 && isConnected) {
				this.pending = undefined;
				if (this.pendingTimeoutId) {
					clearTimeout(this.pendingTimeoutId);
					this.pendingTimeoutId = undefined;
				}
			}

			const insertRes = this.add(node.value, status);
			if (insertRes !== InsertResult.Inserted) {
				// This should be impossible for a reinsert
				return UpdateResult.FailedBucketFull;
			}

			if (notModified) {
				return UpdateResult.NotModified;
			} else if (!wasConnected && isConnected) {
				return UpdateResult.UpdatedAndPromoted;
			} else {
				return UpdateResult.Updated;
			}
		} else if (this.pending && this.pending.value.id === id) {
			this.pending.status = status;
			return UpdateResult.UpdatedPending;
		} else {
			return UpdateResult.FailedKeyNonExistent;
		}
	}

	// ---------- pending logic (reorg candidate) ----------

	/**
	 * Try to mark a new node as "pending" when the bucket is full.
	 * Emits `pendingEviction` with the LRU *disconnected* node.
	 */
	private addPending(value: KadNodeInfo, status: EntryStatus): boolean {
		// we must have some disconnected entries to even consider eviction
		if (!this.pending && this.firstConnectedIndex !== 0) {
			this.pending = { value, status };
			const first = this.nodes[0];
			this.emit("pendingEviction", first.value);
			this.pendingTimeoutId = setTimeout(
				this.applyPending,
				this.pendingTimeoutMs,
			);
			return true;
		}
		return false;
	}

	/**
	 * Called after the pending timeout, or manually from DHT if you want.
	 * If the LRU disconnected node is still disconnected, evict it and
	 * insert the pending node instead.
	 */
	private applyPending = (): void => {
		if (!this.pending) return;

		// bucket full with *only* connected nodes -> drop pending
		if (this.firstConnectedIndex === 0) {
			this.pending = undefined;
			return;
		}

		// evict LRU (index 0) and insert pending
		const evicted = this.removeByIndex(0);
		const inserted = this.pending.value;

		this.add(this.pending.value, this.pending.status);
		this.pending = undefined;
		this.pendingTimeoutId = undefined;

		this.emit("appliedEviction", inserted, evicted.value);
	};

	// ---------- lookups ----------

	get(id: string): KadEntry | undefined {
		return this.nodes.find((entry) => entry.value.id === id);
	}

	getWithPending(id: string): KadEntryFull | undefined {
		const entry = this.get(id);
		if (entry) return { pending: false, ...entry };

		if (this.pending && this.pending.value.id === id) {
			return { pending: true, ...this.pending };
		}
		return undefined;
	}

	getValue(id: string) {
		const e = this.get(id);
		return e?.value;
	}

	getValueByIndex(index: number): KadNodeInfo {
		if (index >= this.nodes.length) {
			throw new Error(`Invalid index in bucket: ${index}`);
		}
		return this.nodes[index].value;
	}

	removeByIndex(index: number): KadEntry {
		if (index >= this.nodes.length) {
			throw new Error(`Invalid index in bucket: ${index}`);
		}
		const entry = this.nodes.splice(index, 1)[0];

		// update firstConnectedIndex
		if (entry.status === EntryStatus.Connected) {
			if (this.firstConnectedIndex === index && index === this.nodes.length) {
				// removed last connected node
				this.firstConnectedIndex = undefined;
			}
		} else {
			// removed a disconnected entry
			if (this.firstConnectedIndex !== undefined) {
				this.firstConnectedIndex =
					this.firstConnectedIndex === 0
						? undefined
						: this.firstConnectedIndex - 1;
			}
		}

		return entry;
	}

	removeById(id: string): KadEntry | undefined {
		const idx = this.nodes.findIndex((e) => e.value.id === id);
		if (idx === -1) return undefined;
		return this.removeByIndex(idx);
	}

	remove(value: KadNodeInfo): KadEntry | undefined {
		return this.removeById(value.id);
	}

	values(): KadNodeInfo[] {
		return this.nodes.map((e) => e.value);
	}

	rawValues(): KadEntry[] {
		return this.nodes.slice();
	}
}
