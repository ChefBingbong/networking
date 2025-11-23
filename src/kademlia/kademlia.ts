// src/kademlia/kademlia.ts
import type { PeerNode } from "../node";
import { RoutingTable } from "./routing-table";
import {
	type Contact,
	type DshtConfig,
	type DshtPointer,
	type KademliaTransport,
	type KadRpc,
	type Key,
	type NodeId,
	type StoredValue,
	type StoredValueOrigin,
} from "./types";
import { UdpKademliaTransport } from "./udp";
import { xorDist } from "./xor";

export interface KademliaConfig {
	k: number; // bucket size
	alpha: number; // lookup parallelism
	idBits: number; // usually 160
	lookupTimeoutMs: number;
	port: number;
	dsht?: DshtConfig;
	/**
	 * Optional TTL for locally stored Kademlia values (in ms).
	 * Expired values are dropped on read and will be republished
	 * by the original publisher if republish is enabled.
	 */
	valueTtlMs?: number;
	/**
	 * How often publishers should republish their values (in ms).
	 * If omitted, a default of valueTtlMs / 2 is used when valueTtlMs
	 * is set, or a conservative fixed interval otherwise.
	 */
	republishIntervalMs?: number;
}

type ShortlistEntry = {
	contact: Contact;
	queried: boolean;
	responded: boolean;
};

type FindValueResult = {
	value: any | null;
	path: Contact[]; // nodes we queried, in query order
	from?: Contact; // node that actually returned the value (if any)
};

export class KademliaNode {
	public table: RoutingTable;
	private store = new Map<Key, StoredValue>();
	public transport!: KademliaTransport;

	/**
	 * Local DSHT state:
	 *   key -> level -> replica pointers[]
	 */
	private dshtStore = new Map<Key, Map<number, DshtPointer[]>>();

	constructor(
		private readonly node: PeerNode,
		public readonly id: NodeId,
		private readonly cfg: KademliaConfig,
	) {
		this.transport = new UdpKademliaTransport(
			this.id,
			"127.0.0.1",
			this.cfg.port,
			async (msg, from) => this.handleRpc(msg, from),
			cfg.lookupTimeoutMs,
		);
		this.table = new RoutingTable(id, { k: cfg.k, idBits: cfg.idBits });
	}

	// ---------- Local DSHT helpers ----------

	private getDshtLevelConfig(level: number) {
		return this.cfg.dsht?.levels.find((l) => l.level === level);
	}

	private dshtGetBucket(key: Key, level: number): DshtPointer[] {
		let perKey = this.dshtStore.get(key);
		if (!perKey) {
			perKey = new Map();
			this.dshtStore.set(key, perKey);
		}
		let bucket = perKey.get(level);
		if (!bucket) {
			bucket = [];
			perKey.set(level, bucket);
		}
		return bucket;
	}

	private dshtHandleLocalPut(
		level: number,
		key: Key,
		pointer: DshtPointer,
	): { ok: boolean; reason?: "full" | "duplicate" } {
		const cfg = this.getDshtLevelConfig(level);
		if (!cfg) {
			return { ok: false, reason: "full" };
		}

		const bucket = this.dshtGetBucket(key, level);
		// de-duplicate by (nodeId, addr)
		if (bucket.some((p) => p.nodeId === pointer.nodeId && p.addr === pointer.addr)) {
			return { ok: false, reason: "duplicate" };
		}

		if (bucket.length >= cfg.maxPointersPerKey) {
			return { ok: false, reason: "full" };
		}

		bucket.push(pointer);
		return { ok: true };
	}

	private dshtHandleLocalGet(
		level: number,
		key: Key,
		limit?: number,
	): DshtPointer[] {
		const bucket = this.dshtGetBucket(key, level);
		if (!bucket.length) return [];
		if (!limit || bucket.length <= limit) return bucket.slice();

		// Return a random subset of pointers, as in Coral DSHT get().
		const shuffled = [...bucket];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
		}
		return shuffled.slice(0, limit);
	}

	/**
	 * Select candidate contacts for DSHT operations at a given cluster level.
	 * We bias toward low-RTT peers within the level's maxRttMs, then unknown RTT,
	 * then higher-RTT peers, all ordered by XOR distance to the key.
	 */
	private getDshtCandidatesForLevel(
		key: Key,
		level: number,
		maxCount: number,
	): Contact[] {
		const levelCfg = this.getDshtLevelConfig(level);
		const all = this.table.allContacts();
		if (!all.length) return [];

		all.sort((a, b) => {
			const da = xorDist(a.id, key);
			const db = xorDist(b.id, key);
			if (da === db) return 0;
			return da < db ? -1 : 1;
		});

		if (!levelCfg) return all.slice(0, maxCount);

		const within: Contact[] = [];
		const unknown: Contact[] = [];
		const outside: Contact[] = [];

		for (const c of all) {
			if (c.lastRttMs == null) {
				unknown.push(c);
			} else if (c.lastRttMs <= levelCfg.maxRttMs) {
				within.push(c);
			} else {
				outside.push(c);
			}
		}

		const ordered = within.concat(unknown, outside);
		return ordered.slice(0, maxCount);
	}

	localStore(
		key: Key,
		value: any,
		origin: StoredValueOrigin = "publisher",
	): void {
		const now = Date.now();
		const entry: StoredValue = { value, storedAt: now, origin };
		this.store.set(key, entry);
	}

	localGet(key: Key): any | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;

		const ttl = this.cfg.valueTtlMs;
		if (ttl !== undefined) {
			const age = Date.now() - entry.storedAt;
			if (age > ttl) {
				this.store.delete(key);
				return undefined;
			}
		}

		return entry.value;
	}

	public async noteContact(contact: Contact): Promise<void> {
		const now = Date.now();
		await this.table.update(
			{
				...contact,
				lastSeen: contact.lastSeen !== undefined ? contact.lastSeen : now,
			},
			(c) => this.ping(c),
		);
	}

	public async pingRandom(count = this.cfg.alpha): Promise<void> {
		const contacts = this.table.allContacts();
		if (!contacts.length) return;

		const shuffled = [...contacts];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}

		const targets = shuffled.slice(0, Math.min(count, shuffled.length));
		await Promise.all(
			targets.map((c) =>
				this.ping(c).catch(() => {
					// ignore errors here; table will be cleaned gradually via failed lookups/pings
				}),
			),
		);
	}

	public randomNodeId(): NodeId {
		const nibbles = Math.ceil(this.cfg.idBits / 4);
		let s = "";
		for (let i = 0; i < nibbles; i++) {
			const nibble = Math.floor(Math.random() * 16);
			s += nibble.toString(16);
		}
		return s as NodeId;
	}

	public async refreshSelf(): Promise<void> {
		await this.nodeLookup(this.id);
	}

	async handleRpc(msg: KadRpc, fromContact: Contact): Promise<KadRpc | null> {
		const contactWithTs: Contact = { ...fromContact, lastSeen: Date.now() };
		await this.table.update(contactWithTs, (c) => this.ping(c));

		switch (msg.type) {
			case "PING":
				return { type: "PONG", from: this.id };

			case "PONG":
				return null;

			case "STORE":
				this.localStore(msg.key, msg.value);
				return null;

			case "FIND_NODE": {
				const closest = this.table.closest(msg.target, this.cfg.k);
				return { type: "FIND_NODE_RESULT", from: this.id, nodes: closest };
			}

			case "FIND_VALUE": {
				const val = this.localGet(msg.key);
				if (val !== undefined) {
					return { type: "FIND_VALUE_RESULT", from: this.id, value: val };
				} else {
					const closest = this.table.closest(msg.key, this.cfg.k);
					return { type: "FIND_VALUE_RESULT", from: this.id, nodes: closest };
				}
			}

			// ---------- DSHT (sloppy hash table) RPCs ----------

			case "DSHT_PUT": {
				const res = this.dshtHandleLocalPut(msg.level, msg.key, msg.pointer);
				return {
					type: "DSHT_PUT_RESULT",
					from: this.id,
					level: msg.level,
					key: msg.key,
					ok: res.ok,
					reason: res.reason,
				};
			}

			case "DSHT_GET": {
				const pointers = this.dshtHandleLocalGet(
					msg.level,
					msg.key,
					msg.limit,
				);
				return {
					type: "DSHT_GET_RESULT",
					from: this.id,
					level: msg.level,
					key: msg.key,
					pointers,
				};
			}

			case "FIND_NODE_RESULT":
			case "FIND_VALUE_RESULT":
			case "DSHT_PUT_RESULT":
			case "DSHT_GET_RESULT":
				return null;
		}
	}

	private async ping(contact: Contact): Promise<boolean> {
		const started = Date.now();
		try {
			const resp = await this.transport.sendRpc(contact, {
				type: "PING",
				from: this.id,
			});
			const rtt = Date.now() - started;
			// NOTE: we only track last RTT for now; could be expanded to EWMA if needed.
			contact.lastRttMs = rtt;
			return resp.type === "PONG";
		} catch {
			return false;
		}
	}

	private async sendFindNode(
		contact: Contact,
		target: NodeId,
	): Promise<Contact[]> {
		const resp = await this.transport.sendRpc(contact, {
			type: "FIND_NODE",
			from: this.id,
			target,
		});
		if (resp.type !== "FIND_NODE_RESULT") return [];
		return resp.nodes ? resp.nodes : [];
	}

	private async sendFindValue(
		contact: Contact,
		key: Key,
	): Promise<{ value?: any; nodes?: Contact[] }> {
		const resp = await this.transport.sendRpc(contact, {
			type: "FIND_VALUE",
			from: this.id,
			key,
		});
		if (resp.type !== "FIND_VALUE_RESULT") return {};
		return { value: resp.value, nodes: resp.nodes };
	}

	private async sendStore(
		contact: Contact,
		key: Key,
		value: any,
	): Promise<void> {
		try {
			await this.transport.sendRpc(contact, {
				type: "STORE",
				from: this.id,
				key,
				value,
			});
		} catch {}
	}

	private async sendDshtPut(
		contact: Contact,
		level: number,
		key: Key,
		pointer: DshtPointer,
	): Promise<{ ok: boolean; reason?: "full" | "duplicate" | "error" }> {
		const resp = await this.transport.sendRpc(contact, {
			type: "DSHT_PUT",
			from: this.id,
			level,
			key,
			pointer,
		});

		if (resp.type !== "DSHT_PUT_RESULT") {
			return { ok: false, reason: "error" };
		}
		if (resp.key !== key || resp.level !== level) {
			return { ok: false, reason: "error" };
		}
		const reason =
			resp.reason !== undefined ? resp.reason : resp.ok ? undefined : "error";
		return { ok: resp.ok, reason };
	}

	private async sendDshtGet(
		contact: Contact,
		level: number,
		key: Key,
		limit?: number,
	): Promise<DshtPointer[]> {
		const resp = await this.transport.sendRpc(contact, {
			type: "DSHT_GET",
			from: this.id,
			level,
			key,
			limit,
		});

		if (resp.type !== "DSHT_GET_RESULT") return [];
		if (resp.key !== key || resp.level !== level) return [];
		return resp.pointers ? resp.pointers : [];
	}

	async nodeLookup(target: NodeId): Promise<Contact[]> {
		// initial shortlist = k closest known nodes
		const initial = this.table.closest(target, this.cfg.k);
		const shortlist = new Map<string, ShortlistEntry>();
		for (const c of initial) {
			shortlist.set(c.id, { contact: c, queried: false, responded: false });
		}

		let probesMade = 0;
		let lastClosestDistance: bigint | null = null;

		while (true) {
			const toQuery = Array.from(shortlist.values())
				.filter((e) => !e.queried)
				.sort((a, b) => {
					const da = xorDist(a.contact.id, target);
					const db = xorDist(b.contact.id, target);
					if (da === db) return 0;
					return da < db ? -1 : 1;
				})
				.slice(0, this.cfg.alpha);

			if (toQuery.length === 0) break;

			const promises = toQuery.map(async (entry) => {
				entry.queried = true;
				const from = entry.contact;
				try {
					const nodes = await this.sendFindNode(from, target);
					entry.responded = true;
					for (const n of nodes) {
						await this.table.update(n, (c) => this.ping(c));
						if (!shortlist.has(n.id)) {
							shortlist.set(n.id, {
								contact: n,
								queried: false,
								responded: false,
							});
						}
					}
				} catch {}
			});

			await Promise.race([
				Promise.all(promises),
				new Promise<void>((resolve) =>
					setTimeout(resolve, this.cfg.lookupTimeoutMs),
				),
			]);

			probesMade += toQuery.length;
			const bestNow = this.bestDistanceTo(target, shortlist);
			if (lastClosestDistance !== null && bestNow >= lastClosestDistance) {
				// no improvement → stop
				break;
			}
			lastClosestDistance = bestNow;
		}

		const final = Array.from(shortlist.values())
			.map((e) => e.contact)
			.sort((a, b) => {
				const da = xorDist(a.id, target);
				const db = xorDist(b.id, target);
				if (da === db) return 0;
				return da < db ? -1 : 1;
			})
			.slice(0, this.cfg.k);

		return final;
	}

	private bestDistanceTo(
		target: NodeId,
		shortlist: Map<string, ShortlistEntry>,
	): bigint {
		let best: bigint | null = null;
		for (const e of shortlist.values()) {
			const d = xorDist(e.contact.id, target);
			if (best === null || d < best) best = d;
		}
		if (best === null) {
			return 2n ** BigInt(this.cfg.idBits);
		}
		return best;
	}

	async storeValue(
		key: Key,
		value: any,
		origin: StoredValueOrigin = "publisher",
	): Promise<void> {
		this.localStore(key, value, origin);

		const closest = await this.nodeLookup(key);
		const targets = closest.slice(0, this.cfg.k);

		await Promise.all(targets.map((c) => this.sendStore(c, key, value)));
	}

	async findValue(key: Key): Promise<FindValueResult> {
		const local = this.localGet(key);
		if (local !== undefined) {
			return {
				value: local,
				path: [],
				from: undefined,
			};
		}

		const initial = this.table.closest(key, this.cfg.k);
		const shortlist = new Map<string, ShortlistEntry>();
		for (const c of initial) {
			shortlist.set(c.id, { contact: c, queried: false, responded: false });
		}

		const queryPath: Contact[] = [];
		let lastClosestDistance: bigint | null = null;

		let foundValue: any | undefined;
		let foundFrom: Contact | undefined;

		while (true) {
			const toQuery = Array.from(shortlist.values())
				.filter((e) => !e.queried)
				.sort((a, b) => {
					const da = xorDist(a.contact.id, key);
					const db = xorDist(b.contact.id, key);
					if (da === db) return 0;
					return da < db ? -1 : 1;
				})
				.slice(0, this.cfg.alpha);

			if (toQuery.length === 0) break;

			for (const entry of toQuery) {
				entry.queried = true;
				queryPath.push(entry.contact);
			}
			await Promise.race([
				Promise.all(
					toQuery.map(async (entry) => {
						const from = entry.contact;
						try {
							const { value, nodes } = await this.sendFindValue(from, key);
							entry.responded = true;

							if (value !== undefined && foundValue === undefined) {
								foundValue = value;
								foundFrom = from;
							}

							if (nodes) {
								for (const n of nodes) {
									await this.table.update(n, (c) => this.ping(c));
									if (!shortlist.has(n.id)) {
										shortlist.set(n.id, {
											contact: n,
											queried: false,
											responded: false,
										});
									}
								}
							}
						} catch {}
					}),
				),
				new Promise<void>((resolve) =>
					setTimeout(resolve, this.cfg.lookupTimeoutMs),
				),
			]);

			if (foundValue !== undefined) {
				// Cache the value locally. We mark it as a "cache" origin so
				// later maintenance can treat publishers vs caches differently.
				this.localStore(key, foundValue, "cache");
				return {
					value: foundValue,
					path: queryPath,
					from: foundFrom,
				};
			}

			const bestNow = this.bestDistanceTo(key, shortlist);
			if (lastClosestDistance !== null && bestNow >= lastClosestDistance) {
				break;
			}
			lastClosestDistance = bestNow;
		}

		return {
			value: null,
			path: queryPath,
			from: undefined,
		};
	}

	/**
	 * Store a DSHT replica pointer for this node at one or more cluster levels.
	 * This implements a Coral-style sloppy insert: each node keeps at most
	 * `maxPointersPerKey` pointers per (key, level), and new inserts "spill"
	 * across nearby nodes when full.
	 *
	 * See: Freedman & Mazières, “Sloppy hashing and self-organizing clusters”
	 * (`https://www.cs.princeton.edu/~mfreed/docs/coral-iptps03.pdf`).
	 */
	async dshtPut(
		key: Key,
		metadata: Record<string, unknown> = {},
		levels?: number[],
	): Promise<void> {
		if (!this.cfg.dsht || !this.cfg.dsht.levels.length) return;

		const activeLevels =
			levels && levels.length
				? levels
				: this.cfg.dsht.levels.map((l) => l.level);

		const pointer: DshtPointer = {
			nodeId: this.id,
			addr: this.node.address.toString(),
			metadata,
		};

		await Promise.all(
			activeLevels.map(async (level) => {
				// Always index locally at this level if we have config for it.
				const levelCfg = this.getDshtLevelConfig(level);
				if (!levelCfg) return;
				this.dshtHandleLocalPut(level, key, pointer);

				const candidates = this.getDshtCandidatesForLevel(
					key,
					level,
					this.cfg.k * 2,
				);
				for (const c of candidates) {
					try {
						const res = await this.sendDshtPut(c, level, key, pointer);
						if (res.ok) {
							// stored successfully at one neighbor; that's enough for this level
							break;
						}
						// on "full" or "duplicate" we fall through to next candidate
					} catch {
						// ignore and try next candidate
					}
				}
			}),
		);
	}

	/**
	 * Look up DSHT replica pointers for a given key at one cluster level.
	 * The result is deliberately a small randomized subset, mirroring Coral's
	 * sloppy get semantics.
	 */
	async dshtGet(
		key: Key,
		level: number,
		opts?: { limit?: number; fanout?: number },
	): Promise<DshtPointer[]> {
		const limit = opts ? opts.limit : undefined;
		const fanout =
			opts && typeof opts.fanout === "number" ? opts.fanout : this.cfg.alpha;

		// 1. Check local DSHT state first.
		const local = this.dshtHandleLocalGet(level, key, limit);
		if (local.length) return local;

		// 2. Query nearby cluster members in parallel.
		const candidates = this.getDshtCandidatesForLevel(key, level, fanout);
		if (!candidates.length) return [];

		const collected: DshtPointer[] = [];

		await Promise.race([
			Promise.all(
				candidates.map(async (c) => {
					try {
						const pointers = await this.sendDshtGet(c, level, key, limit);
						if (!pointers.length) return;
						collected.push(...pointers);
					} catch {
						// ignore failing peers
					}
				}),
			),
			new Promise<void>((resolve) =>
				setTimeout(resolve, this.cfg.lookupTimeoutMs),
			),
		]);

		if (!collected.length) return [];

		// 3. De-duplicate and optionally bound to limit with randomization.
		const dedupMap = new Map<string, DshtPointer>();
		for (const p of collected) {
			const keyStr = `${p.nodeId}|${p.addr}`;
			if (!dedupMap.has(keyStr)) {
				dedupMap.set(keyStr, p);
			}
		}
		const unique = Array.from(dedupMap.values());

		// Opportunistically promote discovered pointers into our local DSHT
		// state. This increases pointer density near active readers, mirroring
		// Coral's demand-driven growth of replica pointers.
		for (const p of unique) {
			this.dshtHandleLocalPut(level, key, p);
		}

		if (!limit || unique.length <= limit) return unique;

		const shuffled = [...unique];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]!] = [shuffled[j]!, shuffled[i]!];
		}
		return shuffled.slice(0, limit);
	}

	/**
	 * Multi-level DSHT lookup: start with the smallest / lowest-RTT cluster
	 * level and expand outward until we find any replica pointers or exhaust
	 * all configured levels.
	 */
	async dshtGetNear(
		key: Key,
		limit = this.cfg.k,
	): Promise<{ level: number; pointers: DshtPointer[] }> {
		if (!this.cfg.dsht || !this.cfg.dsht.levels.length) {
			return { level: -1, pointers: [] };
		}

		const sortedLevels = [...this.cfg.dsht.levels].sort(
			(a, b) => a.maxRttMs - b.maxRttMs,
		);

		for (const lvl of sortedLevels) {
			const pointers = await this.dshtGet(key, lvl.level, { limit });
			if (pointers.length) {
				return { level: lvl.level, pointers };
			}
		}

		return { level: -1, pointers: [] };
	}

	/**
	 * Republish locally-published values whose age exceeds the configured
	 * republish interval. This keeps them alive in the face of churn and
	 * complements local TTL-based expiry.
	 */
	async republishValues(): Promise<void> {
		const now = Date.now();

		const ttl = this.cfg.valueTtlMs;
		const defaultInterval =
			ttl !== undefined ? Math.max(ttl / 2, 60_000) : 10 * 60_000;
		const interval =
			this.cfg.republishIntervalMs !== undefined
				? this.cfg.republishIntervalMs
				: defaultInterval;

		for (const [key, entry] of this.store.entries()) {
			// Only the original publishers are responsible for republishing.
			if (entry.origin !== "publisher") continue;

			const age = now - entry.storedAt;
			if (age < interval) continue;

			try {
				await this.storeValue(key, entry.value, "publisher");
			} catch {
				// Best-effort; failures will be retried on the next interval.
			}
		}
	}

	/**
	 * Debug / analytics helper: summarize DSHT cluster configuration and
	 * pointer distribution for this node. This is not used in the protocol
	 * itself, only for observability (e.g. demo-network).
	 */
	public getDshtDebugSnapshot(): {
		nodeId: NodeId;
		enabled: boolean;
		levels: {
			level: number;
			name: string;
			maxRttMs: number;
			maxPointersPerKey: number;
			contactsWithin: number;
			contactsUnknown: number;
			contactsOutside: number;
			totalPointers: number;
		}[];
	} {
		const cfg = this.cfg.dsht;
		if (!cfg || !cfg.levels.length) {
			return { nodeId: this.id, enabled: false, levels: [] };
		}

		const contacts = this.table.allContacts();

		const levelsSummary: {
			level: number;
			name: string;
			maxRttMs: number;
			maxPointersPerKey: number;
			contactsWithin: number;
			contactsUnknown: number;
			contactsOutside: number;
			totalPointers: number;
		}[] = [];

		for (const lvl of cfg.levels) {
			let contactsWithin = 0;
			let contactsUnknown = 0;
			let contactsOutside = 0;

			for (const c of contacts) {
				if (c.lastRttMs === undefined) {
					contactsUnknown++;
				} else if (c.lastRttMs <= lvl.maxRttMs) {
					contactsWithin++;
				} else {
					contactsOutside++;
				}
			}

			let totalPointers = 0;
			for (const perKey of this.dshtStore.values()) {
				const arr = perKey.get(lvl.level);
				if (arr) {
					totalPointers += arr.length;
				}
			}

			levelsSummary.push({
				level: lvl.level,
				name: lvl.name,
				maxRttMs: lvl.maxRttMs,
				maxPointersPerKey: lvl.maxPointersPerKey,
				contactsWithin,
				contactsUnknown,
				contactsOutside,
				totalPointers,
			});
		}

		return {
			nodeId: this.id,
			enabled: true,
			levels: levelsSummary,
		};
	}

	async bootstrap(seedContacts: Contact[]): Promise<void> {
		for (const c of seedContacts) {
			await this.table.update(c, (contact) => this.ping(contact));
		}
		await this.nodeLookup(this.id);
	}
}
