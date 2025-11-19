// src/kademlia/routing-table.ts
import type { Multiaddr } from "@multiformats/multiaddr";
import { bucketIndexForDistance, xorDistance } from "./xor";

export type KadEntryStatus = "connected" | "questionable";

export interface KadPeer {
	id: string;
	addr: Multiaddr;
	lastSeen: number;
	// Status is tracked per-bucket; this is just here for debugging/introspection.
	status?: KadEntryStatus;
}

export interface KadBucketDump {
	index: number;
	size: number;
	peers: {
		id: string;
		addr: string;
		lastSeen: number;
		status: KadEntryStatus;
	}[];
}

export interface KadRoutingTableDump {
	localId: string;
	totalPeers: number;
	nonEmptyBuckets: number;
	buckets: KadBucketDump[];
}

/**
 * Internal bucket entry with explicit status.
 */
interface BucketEntry {
	peer: KadPeer;
	status: KadEntryStatus;
}

/**
 * A single k-bucket with:
 *  - LRU ordering (index 0 = least recently seen)
 *  - simple pending-eviction logic (like discv5, but pared down)
 *
 * Pending behaviour:
 *  - when bucket is full and a new peer arrives:
 *    - if there is at least one "questionable" entry, we:
 *      - mark the new peer as "pending"
 *      - emit onPendingEviction(victim) for the LRU questionable entry
 *      - start a timer
 *    - if the victim proves liveness (we call addPeer on it again),
 *      the pending entry is dropped
 *    - if the timer fires and victim did *not* prove liveness,
 *      we evict victim and insert pending, then emit onAppliedEviction
 */
// inside src/kademlia/routing-table.ts

class Bucket {
	private readonly entries: BucketEntry[] = [];
	private readonly k: number;

	private pending?: {
		entry: BucketEntry;
		victimId: string;
		timer: NodeJS.Timeout;
	};

	constructor(
		k: number,
		private readonly pendingTimeoutMs: number,
		private readonly onPendingEviction?: (victim: KadPeer) => void,
		private readonly onAppliedEviction?: (
			inserted: KadPeer,
			evicted?: KadPeer,
		) => void,
	) {
		this.k = k;
	}

	// ---------------- add / update ----------------

	addOrUpdate(peer: KadPeer, status: KadEntryStatus = "connected") {
		const id = peer.id.toString();

		// existing entry → refresh + move to tail
		const idx = this.entries.findIndex((e) => e.peer.id.toString() === id);
		if (idx >= 0) {
			const existing = this.entries.splice(idx, 1)[0]!;
			existing.peer = { ...peer };
			existing.status = status;

			// if this was the pending victim and it just proved liveness, drop pending
			if (
				this.pending &&
				this.pending.victimId === id &&
				status === "connected"
			) {
				clearTimeout(this.pending.timer);
				this.pending = undefined;
			}

			this.entries.push(existing);
			return;
		}

		// bucket has room → just append
		if (this.entries.length < this.k) {
			this.entries.push({ peer: { ...peer }, status });
			return;
		}

		// bucket full → try pending eviction against a questionable LRU
		this.maybeAddPending(peer, status);
	}

	private maybeAddPending(peer: KadPeer, status: KadEntryStatus) {
		// if we already have a pending candidate, just drop this new peer
		if (this.pending) return;

		// find the *oldest* questionable entry
		const victimIdx = this.entries.findIndex(
			(e) => e.status === "questionable",
		);
		if (victimIdx < 0) {
			// no questionable entries: we keep the existing connected peers
			return;
		}

		const victim = this.entries[victimIdx]!.peer;

		// register pending entry
		const pendingEntry: BucketEntry = { peer: { ...peer }, status };
		const timer = setTimeout(() => this.applyPending(), this.pendingTimeoutMs);

		this.pending = {
			entry: pendingEntry,
			victimId: victim.id.toString(),
			timer,
		};

		this.onPendingEviction?.(victim);
	}

	private applyPending() {
		if (!this.pending) return;

		// if victim is still present & *not* connected, evict it
		const victimIdx = this.entries.findIndex(
			(e) =>
				e.peer.id.toString() === this.pending!.victimId &&
				e.status === "questionable",
		);

		if (victimIdx >= 0) {
			const evicted = this.entries.splice(victimIdx, 1)[0]!;
			this.entries.push(this.pending.entry);
			this.onAppliedEviction?.(this.pending.entry.peer, evicted.peer);
		}

		clearTimeout(this.pending.timer);
		this.pending = undefined;
	}

	// ---------------- removal & pruning ----------------

	/**
	 * Remove a single peer by id. Returns the removed KadPeer if found.
	 */
	removePeer(id: string): KadPeer | undefined {
		const idx = this.entries.findIndex((e) => e.peer.id.toString() === id);
		if (idx < 0) return;

		const [removed] = this.entries.splice(idx, 1);

		// if this peer was the pending victim, clear the pending state
		if (this.pending && this.pending.victimId === id) {
			clearTimeout(this.pending.timer);
			this.pending = undefined;
		}

		return removed.peer;
	}

	/**
	 * Bulk prune peers matching a predicate.
	 * Returns the list of KadPeers that were removed.
	 */
	prune(
		predicate: (peer: KadPeer, status: KadEntryStatus) => boolean,
	): KadPeer[] {
		const removed: KadPeer[] = [];

		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i]!;
			if (predicate(e.peer, e.status)) {
				const [spliced] = this.entries.splice(i, 1);
				removed.push(spliced.peer);
			}
		}

		// if bucket no longer contains the pending victim, drop pending
		if (this.pending) {
			const stillHasVictim = this.entries.some(
				(e) => e.peer.id.toString() === this.pending!.victimId,
			);
			if (!stillHasVictim) {
				clearTimeout(this.pending.timer);
				this.pending = undefined;
			}
		}

		return removed;
	}

	// ---------------- status & introspection ----------------

	setStatus(id: string, status: KadEntryStatus) {
		const idx = this.entries.findIndex((e) => e.peer.id.toString() === id);
		if (idx < 0) return;

		const entry = this.entries[idx]!;
		entry.status = status;

		// move to tail when we mark as connected (fresh activity)
		if (status === "connected") {
			this.entries.splice(idx, 1);
			this.entries.push(entry);

			if (this.pending && this.pending.victimId === id) {
				clearTimeout(this.pending.timer);
				this.pending = undefined;
			}
		}
	}

	getAllPeers(): KadPeer[] {
		return this.entries.map((e) => ({
			...e.peer,
			status: e.status,
		}));
	}

	dump(index: number): KadBucketDump | null {
		if (this.entries.length === 0) return null;
		return {
			index,
			size: this.entries.length,
			peers: this.entries.map((e) => ({
				id: e.peer.id.toString(),
				addr: e.peer.addr.toString(),
				lastSeen: e.peer.lastSeen,
				status: e.status,
			})),
		};
	}
}

export class RoutingTable {
	private readonly buckets: Bucket[] = [];

	// optional callbacks for higher-level logic (KademliaDHT)
	public onPendingEviction?: (victim: KadPeer) => void;
	public onAppliedEviction?: (inserted: KadPeer, evicted?: KadPeer) => void;

	constructor(
		private readonly localId: string,
		private readonly k: number,
		maxBuckets = 256,
		private readonly pendingTimeoutMs = 5_000,
	) {
		for (let i = 0; i < maxBuckets; i++) {
			this.buckets.push(
				new Bucket(
					this.k,
					this.pendingTimeoutMs,
					(victim) => this.onPendingEviction?.(victim),
					(ins, ev) => this.onAppliedEviction?.(ins, ev),
				),
			);
		}
	}

	addPeer(peer: KadPeer, status: KadEntryStatus = "connected") {
		// avoid ever inserting ourselves
		if (peer.id.toString() === this.localId) return;

		const dist = xorDistance(this.localId, peer.id.toString());
		const idx = bucketIndexForDistance(dist);
		const bucket = this.buckets[idx];
		bucket.addOrUpdate(peer, status);
	}

	setPeerStatus(id: string, status: KadEntryStatus) {
		for (const bucket of this.buckets) {
			bucket.setStatus(id, status);
		}
	}

	/**
	 * Remove a single peer by id from whichever bucket it lives in.
	 * Returns the removed KadPeer if it existed.
	 */
	removePeer(id: string): KadPeer | undefined {
		for (const bucket of this.buckets) {
			const removed = bucket.removePeer(id);
			if (removed) return removed;
		}
		return undefined;
	}

	/**
	 * Prune stale peers across all buckets.
	 *
	 * By default we only prune peers that:
	 *  - are "questionable"
	 *  - and have lastSeen < now - maxAgeMs
	 *
	 * Returns list of removed KadPeers (for logging / metrics).
	 */
	pruneStale(maxAgeMs: number, onlyQuestionable = true): KadPeer[] {
		const cutoff = Date.now() - maxAgeMs;
		const removed: KadPeer[] = [];

		for (const bucket of this.buckets) {
			const bucketRemoved = bucket.prune((peer, status) => {
				if (onlyQuestionable && status !== "questionable") return false;
				return peer.lastSeen < cutoff;
			});
			removed.push(...bucketRemoved);
		}

		return removed;
	}

	getAllPeers(): KadPeer[] {
		return this.buckets.flatMap((b) => b.getAllPeers());
	}

	getClosestPeers(targetId: string, limit: number): KadPeer[] {
		const all = this.getAllPeers();
		all.sort((a, b) => {
			const da = xorDistance(a.id.toString(), targetId);
			const db = xorDistance(b.id.toString(), targetId);
			if (da < db) return -1;
			if (da > db) return 1;
			return 0;
		});
		return all.slice(0, limit);
	}

	getRandomPeers(limit: number): KadPeer[] {
		const all = this.getAllPeers();
		if (all.length <= limit) return all;

		const out: KadPeer[] = [];
		const used = new Set<number>();

		while (out.length < limit && used.size < all.length) {
			const idx = Math.floor(Math.random() * all.length);
			if (used.has(idx)) continue;
			used.add(idx);
			out.push(all[idx]!);
		}
		return out;
	}

	dump(): KadRoutingTableDump {
		const buckets: KadBucketDump[] = [];
		let total = 0;

		for (let i = 0; i < this.buckets.length; i++) {
			const d = this.buckets[i]!.dump(i);
			if (!d) continue;
			total += d.size;
			buckets.push(d);
		}

		return {
			localId: this.localId,
			totalPeers: total,
			nonEmptyBuckets: buckets.length,
			buckets,
		};
	}
}
