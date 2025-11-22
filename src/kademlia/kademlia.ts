// src/kademlia/kademlia.ts
import type { PeerNode } from "../node";
import { RoutingTable } from "./routing-table";
import type { Contact, KademliaTransport, KadRpc, Key, NodeId } from "./types";
import { UdpKademliaTransport } from "./udp";
import { xorDist } from "./xor";

export interface KademliaConfig {
	k: number; // bucket size
	alpha: number; // lookup parallelism
	idBits: number; // usually 160
	lookupTimeoutMs: number;
	port: number;
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
	private store = new Map<Key, any>();
	public transport!: KademliaTransport;

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

	/* ------------ local K/V store ------------ */

	localStore(key: Key, value: any) {
		this.store.set(key, value);
	}

	localGet(key: Key): any | undefined {
		return this.store.get(key);
	}

	/* ------------ public helpers for integration ------------ */

	/**
	 * Note a contact we learned via some other channel (e.g. TCP connection).
	 * Updates routing table and pings if needed (as per original paper).
	 */
	public async noteContact(contact: Contact): Promise<void> {
		await this.table.update(contact, (c) => this.ping(c));
	}

	/**
	 * Ping some random contacts in the table to keep liveness information fresh.
	 */
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

	/**
	 * Generate a random NodeId in the same bit-space as our IDs.
	 * Used for periodic random lookups to keep buckets fresh.
	 */
	public randomNodeId(): NodeId {
		const nibbles = Math.ceil(this.cfg.idBits / 4);
		let s = "";
		for (let i = 0; i < nibbles; i++) {
			const nibble = Math.floor(Math.random() * 16);
			s += nibble.toString(16);
		}
		return s as NodeId;
	}

	/**
	 * Classic “refresh yourself” lookup from the paper (lookup on your own ID).
	 */
	public async refreshSelf(): Promise<void> {
		await this.nodeLookup(this.id);
	}

	/* ------------ RPC handler for incoming messages ------------ */

	/**
	 * Called by the UDP transport when a KadRpc arrives.
	 * Return a response KadRpc or null (for one-way messages).
	 */
	async handleRpc(msg: KadRpc, fromContact: Contact): Promise<KadRpc | null> {
		// Paper says: update routing table on every message we see from a node
		await this.table.update(fromContact, (c) => this.ping(c));

		switch (msg.type) {
			case "PING":
				return { type: "PONG", from: this.id };

			case "PONG":
				// nothing special; table already updated from `fromContact`
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

			case "FIND_NODE_RESULT":
			case "FIND_VALUE_RESULT":
				// These should be seen only as responses, not handled here.
				return null;
		}
	}

	/* ------------ basic RPC helpers ------------ */

	private async ping(contact: Contact): Promise<boolean> {
		try {
			const resp = await this.transport.sendRpc(contact, {
				type: "PING",
				from: this.id,
			});
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
		return resp.nodes ?? [];
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
		// fire and forget; spec doesn’t require ACK for STORE
		try {
			await this.transport.sendRpc(contact, {
				type: "STORE",
				from: this.id,
				key,
				value,
			});
		} catch {
			// ignore failures; replication will handle redundancy
		}
	}

	/* ------------ iterative node lookup (original algorithm) ------------ */

	/**
	 * Iterative FIND_NODE lookup, Section 2.3 in paper.
	 * Returns up to k closest nodes to target that this node knows after the lookup.
	 */
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
			// pick up to α closest *unqueried* nodes
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

			// send parallel FIND_NODE RPCs
			const promises = toQuery.map(async (entry) => {
				entry.queried = true;
				const from = entry.contact;
				try {
					const nodes = await this.sendFindNode(from, target);
					entry.responded = true;
					// Update routing table for each discovered node
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
				} catch {
					// timeout or error - treat as non-responding; routing table will be cleaned up via future pings
				}
			});

			await Promise.race([
				Promise.all(promises),
				new Promise<void>((resolve) =>
					setTimeout(resolve, this.cfg.lookupTimeoutMs),
				),
			]);

			probesMade += toQuery.length;

			// Convergence check: did we get any closer nodes since last iteration?
			const bestNow = this.bestDistanceTo(target, shortlist);
			if (lastClosestDistance !== null && bestNow >= lastClosestDistance) {
				// no improvement → stop
				break;
			}
			lastClosestDistance = bestNow;
		}

		// return up to k closest from final shortlist
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
		return best ?? 2n ** BigInt(this.cfg.idBits);
	}

	/* ------------ STORE / FIND_VALUE with iterative lookup ------------ */

	/**
	 * Store (key, value) in the k nodes closest to key.
	 * Paper: first perform `nodeLookup(key)`, then send STORE to those nodes.
	 */
	async storeValue(key: Key, value: any): Promise<void> {
		// also store locally
		this.localStore(key, value);

		const closest = await this.nodeLookup(key);
		const targets = closest.slice(0, this.cfg.k);

		await Promise.all(targets.map((c) => this.sendStore(c, key, value)));
	}

	/**
	 * Full FIND_VALUE per paper:
	 *  - if someone responds with a value → return that and STOP
	 *  - otherwise we converge like FIND_NODE and return null
	 */
	// Adjust return type as you like

	async findValue(key: Key): Promise<FindValueResult> {
		// 1) Local hit: no path, no remote source
		const local = this.localGet(key);
		if (local !== undefined) {
			return {
				value: local,
				path: [],
				from: undefined,
			};
		}

		// 2) Initial shortlist
		const initial = this.table.closest(key, this.cfg.k);
		const shortlist = new Map<string, ShortlistEntry>();
		for (const c of initial) {
			shortlist.set(c.id, { contact: c, queried: false, responded: false });
		}

		// Track which contacts we actually queried, in the order we launched requests
		const queryPath: Contact[] = [];
		let lastClosestDistance: bigint | null = null;

		// Track where the value came from
		let foundValue: any | undefined;
		let foundFrom: Contact | undefined;

		while (true) {
			// pick up to α closest *unqueried* nodes
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

			// mark them as queried and append to path before sending
			for (const entry of toQuery) {
				entry.queried = true;
				queryPath.push(entry.contact);
			}

			// ask α nodes in parallel for FIND_VALUE
			await Promise.race([
				Promise.all(
					toQuery.map(async (entry) => {
						const from = entry.contact;
						try {
							const { value, nodes } = await this.sendFindValue(from, key);
							entry.responded = true;

							// first value wins
							if (value !== undefined && foundValue === undefined) {
								foundValue = value;
								foundFrom = from;
							}

							// incorporate returned nodes into routing table & shortlist
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
						} catch {
							// ignore errors here; node just doesn't respond
						}
					}),
				),
				new Promise<void>((resolve) =>
					setTimeout(resolve, this.cfg.lookupTimeoutMs),
				),
			]);

			// If we found a value in this round, cache & return with path/source
			if (foundValue !== undefined) {
				this.localStore(key, foundValue);
				return {
					value: foundValue,
					path: queryPath,
					from: foundFrom,
				};
			}

			// convergence check: did we get any closer nodes?
			const bestNow = this.bestDistanceTo(key, shortlist);
			if (lastClosestDistance !== null && bestNow >= lastClosestDistance) {
				break;
			}
			lastClosestDistance = bestNow;
		}

		// Not found anywhere
		return {
			value: null,
			path: queryPath,
			from: undefined,
		};
	}

	/* ------------ bootstrap helper ------------ */

	/**
	 * Join the network by seeding the table with known contacts and performing
	 * a lookup on our own ID (paper Section 2.4).
	 */
	async bootstrap(seedContacts: Contact[]): Promise<void> {
		for (const c of seedContacts) {
			await this.table.update(c, (contact) => this.ping(contact));
		}
		await this.nodeLookup(this.id);
	}
}
