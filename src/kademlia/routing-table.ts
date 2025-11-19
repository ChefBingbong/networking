// src/kademlia/routing-table.ts
import type { Multiaddr } from "@multiformats/multiaddr";
import { bucketIndexForDistance, xorDistance } from "./xor";

export type KadPeerStatus = "connected" | "questionable" | "dead";

export interface KadPeer {
	id: string;
	addr: Multiaddr;
	lastSeen: number;
	status: KadPeerStatus;
}

export interface KadBucketDump {
	index: number;
	size: number;
	peers: {
		id: string;
		addr: string;
		lastSeen: number;
		status: KadPeerStatus;
	}[];
}

export interface KadRoutingTableDump {
	localId: string;
	totalPeers: number;
	nonEmptyBuckets: number;
	buckets: KadBucketDump[];
}

export interface AddPeerResult {
	inserted: boolean;
	updated: boolean;
	evicted?: KadPeer;
}

export class RoutingTable {
	// bucket i holds peers at “distance scale” i
	private readonly buckets: KadPeer[][] = [];

	constructor(
		private readonly localId: string,
		private readonly k: number, // bucket capacity
		maxBuckets = 256,
	) {
		for (let i = 0; i < maxBuckets; i++) {
			this.buckets.push([]);
		}
	}

	/**
	 * Insert or update a peer in the appropriate bucket.
	 * Returns whether it was inserted/updated and (optionally) an evicted peer.
	 */
	addPeer(peer: KadPeer): AddPeerResult {
		// Don't add ourselves
		if (peer.id === this.localId) {
			return { inserted: false, updated: false };
		}

		const dist = xorDistance(this.localId, peer.id.toString());
		const idx = bucketIndexForDistance(dist);
		const bucket = this.buckets[idx];
		const now = Date.now();

		// already in bucket, refresh
		const existingIndex = bucket.findIndex((p) => p.id === peer.id);
		if (existingIndex >= 0) {
			const existing = bucket.splice(existingIndex, 1)[0]!;
			existing.addr = peer.addr;
			existing.lastSeen = now;
			existing.status = peer.status ?? existing.status;
			bucket.push(existing);
			return { inserted: false, updated: true };
		}

		// room in bucket
		if (bucket.length < this.k) {
			bucket.push({
				...peer,
				lastSeen: now,
			});
			return { inserted: true, updated: false };
		}

		// bucket full -> evict the LRU *preferably* a non-connected peer
		let evictIndex = 0;
		for (let i = 0; i < bucket.length; i++) {
			if (bucket[i]!.status !== "connected") {
				evictIndex = i;
				break;
			}
		}

		const evicted = bucket.splice(evictIndex, 1)[0]!;
		bucket.push({
			...peer,
			lastSeen: now,
		});

		return { inserted: true, updated: false, evicted };
	}

	getAllPeers(): KadPeer[] {
		return this.buckets.flat();
	}

	getClosestPeers(targetId: string, limit: number): KadPeer[] {
		const all = this.getAllPeers();
		all.sort((a, b) => {
			const da = xorDistance(a.id.toString(), targetId);
			const db = xorDistance(b.id.toString(), targetId);
			return Buffer.compare(da, db);
		});
		return all.slice(0, limit);
	}

	/**
	 * Mark a peer as alive / recently seen.
	 */
	markPeerAlive(id: string) {
		const now = Date.now();
		for (const bucket of this.buckets) {
			const idx = bucket.findIndex((p) => p.id === id);
			if (idx === -1) continue;

			const peer = bucket.splice(idx, 1)[0]!;
			peer.lastSeen = now;
			peer.status = "connected";
			bucket.push(peer);
			return;
		}
	}

	/**
	 * Return peers that haven't been seen in > staleMs, oldest first.
	 */
	getStalePeers(staleMs: number, limit: number): KadPeer[] {
		const now = Date.now();
		const all = this.getAllPeers();
		const stale = all.filter((p) => now - p.lastSeen >= staleMs);
		stale.sort((a, b) => a.lastSeen - b.lastSeen);
		return stale.slice(0, limit);
	}

	/**
	 * Return up to `limit` random peers from random buckets.
	 */
	getRandomPeers(limit: number): KadPeer[] {
		const all = this.getAllPeers();
		if (all.length <= limit) return all.slice();
		const copy = all.slice();
		for (let i = copy.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[copy[i], copy[j]] = [copy[j]!, copy[i]!];
		}
		return copy.slice(0, limit);
	}

	dump(): KadRoutingTableDump {
		const buckets: KadBucketDump[] = [];
		let total = 0;
		for (let i = 0; i < this.buckets.length; i++) {
			const bucket = this.buckets[i];
			if (bucket.length === 0) continue;
			total += bucket.length;
			buckets.push({
				index: i,
				size: bucket.length,
				peers: bucket.map((p) => ({
					id: p.id.toString(),
					addr: p.addr.toString(),
					lastSeen: p.lastSeen,
					status: p.status,
				})),
			});
		}
		return {
			localId: this.localId,
			totalPeers: total,
			nonEmptyBuckets: buckets.length,
			buckets,
		};
	}
}
