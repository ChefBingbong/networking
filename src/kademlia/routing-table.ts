import { KBucket } from "./bucket";
import type { Contact, NodeId } from "./types";
import { bucketIndex, xorDist } from "./xor";

export interface RoutingTableConfig {
	k: number; // bucket size (paper: k ~ 20)
	idBits: number; // usually 160
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
	 * Paper 2.2: "Updating the k-buckets"
	 *
	 * - On any contact with node n:
	 *   • If n already exists in bucket → move it to tail.
	 *   • Else if bucket not full → append it.
	 *   • Else (bucket full) → ping least-recently seen node:
	 *       if responds, keep existing node and discard n;
	 *       otherwise, replace it with n.
	 */
	async update(
		contact: Contact,
		pingFn: (c: Contact) => Promise<boolean>,
	): Promise<void> {
		if (contact.id === this.selfId) return; // never store ourselves

		const bucket = this.getBucketFor(contact.id);

		if (bucket.has(contact.id)) {
			bucket.touch(contact);
			return;
		}

		if (!bucket.isFull()) {
			bucket.pushNew(contact);
			return;
		}

		// bucket is full → ping oldest (LRU)
		const oldest = bucket.getOldest();
		if (!oldest) {
			// should not happen, but just insert
			bucket.pushNew(contact);
			return;
		}

		const alive = await pingFn(oldest);
		if (!alive) {
			bucket.replaceOldest(contact);
		} else {
			// oldest still alive → keep it, drop new contact
			bucket.touch(oldest);
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
