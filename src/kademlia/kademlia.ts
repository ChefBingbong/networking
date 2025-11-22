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

	localStore(key: Key, value: any) {
		this.store.set(key, value);
	}

	localGet(key: Key): any | undefined {
		return this.store.get(key);
	}

	public async noteContact(contact: Contact): Promise<void> {
		const now = Date.now();
		await this.table.update(
			{ ...contact, lastSeen: contact.lastSeen ?? now },
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

			case "FIND_NODE_RESULT":
			case "FIND_VALUE_RESULT":
				return null;
		}
	}

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
		try {
			await this.transport.sendRpc(contact, {
				type: "STORE",
				from: this.id,
				key,
				value,
			});
		} catch {}
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
		return best ?? 2n ** BigInt(this.cfg.idBits);
	}

	async storeValue(key: Key, value: any): Promise<void> {
		this.localStore(key, value);

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
				this.localStore(key, foundValue);
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

	async bootstrap(seedContacts: Contact[]): Promise<void> {
		for (const c of seedContacts) {
			await this.table.update(c, (contact) => this.ping(contact));
		}
		await this.nodeLookup(this.id);
	}
}
