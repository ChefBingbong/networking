// src/kademlia/routing-table.ts
import type { Multiaddr } from "@multiformats/multiaddr";
import { bucketIndexForDistance, xorDistance } from "./xor";

export interface KadPeer {
	id: string;
	addr: Multiaddr;
	lastSeen: number;
}

export interface KadBucketDump {
	index: number;
	size: number;
	peers: {
		id: string;
		addr: string;
		lastSeen: number;
	}[];
}

export interface KadRoutingTableDump {
	localId: string;
	totalPeers: number;
	nonEmptyBuckets: number;
	buckets: KadBucketDump[];
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

	addPeer(peer: KadPeer) {
		if (peer.addr.toString() === this.localId) return;
		const dist = xorDistance(this.localId, peer.id.toString());
		const idx = bucketIndexForDistance(dist);
		const bucket = this.buckets[idx];

		// if already in bucket, move to tail & refresh lastSeen
		const existingIndex = bucket.findIndex(
			(p) => p.id.toString() === peer.id.toString(),
		);
		if (existingIndex >= 0) {
			const existing = bucket.splice(existingIndex, 1)[0]!;
			existing.lastSeen = peer.lastSeen;
			existing.addr = peer.addr;
			bucket.push(existing);
			return;
		}

		// if bucket has room, append
		if (bucket.length < this.k) {
			bucket.push(peer);
			return;
		}

		// bucket full; in real Kad you'd PING LRU; here we just drop LRU
		bucket.shift();
		bucket.push(peer);
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
