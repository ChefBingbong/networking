// src/kademlia/routing-table.ts
import { KBucket } from "./bucket";
import type { Contact, NodeId } from "./types";
import { bucketIndex, xorDist } from "./xor";

export interface RoutingTableConfig {
	k: number; // bucket size
	idBits: number; // number of bits in NodeId keyspace
}

export class RoutingTable {
	public buckets: KBucket[];

	constructor(
		private readonly selfId: NodeId,
		private readonly cfg: RoutingTableConfig,
	) {
		this.buckets = Array.from({ length: cfg.idBits }, () => new KBucket(cfg.k));
	}

	private getBucketFor(id: NodeId): KBucket {
		const idx = bucketIndex(this.selfId, id, this.cfg.idBits);
		return this.buckets[idx]!;
	}

	/**
	 * Paper 2.2: Updating the k-buckets.
	 */
	async update(
		contact: Contact,
		pingFn: (c: Contact) => Promise<boolean>,
	): Promise<void> {
		if (contact.id === this.selfId) return;

		const bucket = this.getBucketFor(contact.id);
		const now = Date.now();
		const withTs: Contact = { ...contact, lastSeen: contact.lastSeen ?? now };

		// 1. If n already exists in bucket, move it to tail (most recently seen).
		if (bucket.has(withTs.id)) {
			bucket.touch(withTs);
			return;
		}

		// 2. If bucket not full, append.
		if (!bucket.isFull()) {
			bucket.pushNew(withTs);
			return;
		}

		// 3. Bucket full: ping least recently seen node.
		const oldest = bucket.getOldest();
		if (!oldest) {
			// Shouldn't happen, but just insert.
			bucket.pushNew(withTs);
			return;
		}

		const alive = await pingFn(oldest);

		if (!alive) {
			// oldest is dead → replace with new node
			bucket.replaceOldest(withTs);
		} else {
			// oldest responded → keep it, drop new node
			const refreshedOldest: Contact = {
				...oldest,
				lastSeen: Date.now(),
			};
			bucket.touch(refreshedOldest);
		}
	}

	remove(id: NodeId) {
		const bucket = this.getBucketFor(id);
		bucket.remove(id);
	}

	/**
	 * Return up to `k` contacts closest to targetId.
	 */
	closest(targetId: NodeId, k = this.cfg.k): Contact[] {
		const all: Contact[] = [];
		for (const b of this.buckets) {
			all.push(...b.getAll());
		}
		all.sort((a, b) => {
			const da = xorDist(a.id, targetId);
			const db = xorDist(b.id, targetId);
			if (da === db) return 0;
			return da < db ? -1 : 1;
		});
		return all.slice(0, k);
	}

	allContacts(): Contact[] {
		const out: Contact[] = [];
		for (const b of this.buckets) out.push(...b.getAll());
		return out;
	}

	getNonEmptyBucketCount(): number {
		return this.buckets.filter((b) => b.nonEmptyCount() > 0).length;
	}

	getNonEmptyBuckets(): KBucket[] {
		return this.buckets.filter((b) => b.nonEmptyCount() > 0);
	}

	totalContactCount(): number {
		return this.buckets.reduce((sum, b) => sum + b.nonEmptyCount(), 0);
	}

	dump() {
		const buckets = [];
		let total = 0;

		for (let i = 0; i < this.buckets.length; i++) {
			const d = this.buckets[i].dump(i);
			if (!d) continue;
			total += d.size;
			buckets.push(d);
		}

		return {
			localId: this.selfId,
			totalPeers: total,
			nonEmptyBuckets: buckets.length,
			buckets,
		};
	}
}
