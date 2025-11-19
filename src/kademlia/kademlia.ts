// src/kademlia/kademlia.ts

import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { RemoteInfo } from "dgram";
import { KadUdpTransport } from "./kad-udp-transport";
import { type KadRoutingTableDump, RoutingTable } from "./routing-table";

const log = debug("p2p:kad");

export const KADEMLIA_PROTOCOL = "/kad/1.0.0";

export interface KadNodeInfo {
	id: string;
	addr: string;
}

interface KadBase {
	from: string;
	rpcId?: string; // used for UDP request/response matching
}

export type KadMessage =
	| (KadBase & { type: "PING" })
	| (KadBase & { type: "PONG" })
	| (KadBase & { type: "FIND_NODE"; target: string })
	| (KadBase & { type: "NODES"; target: string; nodes: KadNodeInfo[] })
	| (KadBase & { type: "STORE"; key: string; value: any })
	| (KadBase & { type: "FIND_VALUE"; key: string })
	| (KadBase & { type: "VALUE"; key: string; value: any });

export interface KademliaConfig {
	k: number;
	alpha: number;
	maxBuckets: number;
}

export interface KademliaOptions extends Partial<KademliaConfig> {
	/** Node id in the Kad keyspace (e.g. your libp2p PeerId string). */
	localId: string;
	/** UDP bind host for Kad. */
	udpHost: string;
	/** UDP bind port for Kad. */
	udpPort: number;
	/**
	 * Canonical advertised multiaddr for this node (usually TCP with /p2p/),
	 * used when we return ourselves in NODES / VALUE replies.
	 */
	selfAddr?: Multiaddr;
}

type StoredValue = {
	value: any;
	storedAt: number;
};

// For UDP RPC matching
type PendingRpc =
	| {
			type: "FIND_NODE";
			resolve: (nodes: KadNodeInfo[]) => void;
			timer: NodeJS.Timeout;
	  }
	| {
			type: "FIND_VALUE";
			resolve: (res: { value?: any; nodes?: KadNodeInfo[] }) => void;
			timer: NodeJS.Timeout;
	  };

export class KademliaDHT {
	private readonly localId: string;
	private readonly cfg: KademliaConfig;
	private readonly table: RoutingTable;
	private readonly store = new Map<string, StoredValue>();

	private readonly udp: KadUdpTransport;
	private readonly selfAddr?: Multiaddr;

	// pending RPCs keyed by rpcId
	private pending = new Map<string, PendingRpc>();

	constructor(opts: KademliaOptions) {
		this.localId = opts.localId;
		this.selfAddr = opts.selfAddr;

		this.cfg = {
			k: opts.k ?? 16,
			alpha: opts.alpha ?? 3,
			maxBuckets: opts.maxBuckets ?? 256,
		};

		this.table = new RoutingTable(
			this.localId,
			this.cfg.k,
			this.cfg.maxBuckets,
		);

		this.udp = new KadUdpTransport(opts.udpHost, opts.udpPort, (msg, rinfo) =>
			this.onUdpMessage(msg, rinfo),
		);

		log(
			`Kad DHT started for id=${this.localId} on udp://${opts.udpHost}:${opts.udpPort}`,
		);
	}

	// ---------- basic peer injection APIs ----------

	/** Add / refresh a Kad peer (id + addr) in the routing table. */
	public notePeer(id: string, addr: Multiaddr) {
		this.table.addPeer({
			id,
			addr,
			lastSeen: Date.now(),
		});
	}

	/** Convenience: feed a TCP multiaddr that includes /p2p/<peerId>. */
	public noteConnectedPeer(addr: Multiaddr) {
		const idStr = this.extractPeerId(addr);
		if (!idStr) return;
		this.notePeer(idStr, addr);
	}

	/** Add bootstrap nodes with explicit id + addr (usually static config). */
	public addBootstrapNodes(nodes: KadNodeInfo[]) {
		const now = Date.now();
		for (const n of nodes) {
			try {
				const addr = multiaddr(n.addr);
				this.table.addPeer({
					id: n.id,
					addr,
					lastSeen: now,
				});
			} catch {
				continue;
			}
		}
	}

	/** Convenience: add bootstrap from full multiaddrs containing /p2p/<id>. */
	public addBootstrapAddrs(addrs: Multiaddr[]) {
		const now = Date.now();
		for (const addr of addrs) {
			const id = this.extractPeerId(addr);
			if (!id) continue;
			this.table.addPeer({
				id,
				addr,
				lastSeen: now,
			});
		}
	}

	// ---------- bootstrapping / iterative lookup ----------

	/**
	 * Simple graph-walking bootstrap: repeatedly FIND_NODE(localId) from the
	 * closest peers we know, adding anything new to the table until it
	 * stabilises or we run out of peers.
	 */
	public async bootstrapLookup(maxRounds = 3): Promise<void> {
		if (this.table.getAllPeers().length === 0) {
			log("bootstrapLookup: no peers in table, did you add bootstraps?");
			return;
		}

		const visited = new Set<string>();
		let round = 0;

		while (round < maxRounds) {
			round++;

			const frontier = this.table
				.getClosestPeers(this.localId, this.cfg.k)
				// .filter((p) => !visited.has(p.id))
				.slice(0, this.cfg.alpha);

			if (frontier.length === 0) {
				log("bootstrapLookup: frontier exhausted");
				break;
			}

			frontier.forEach((p) => visited.add(p.id));
			log(`bootstrapLookup: round=${round}, querying ${frontier.length} peers`);

			const replies = await Promise.all(
				frontier.map((p) => this.sendFindNodeUdp(p.addr, this.localId)),
			);

			let addedAny = false;
			const now = Date.now();

			for (const nodes of replies) {
				for (const n of nodes) {
					try {
						const addr = multiaddr(n.addr);
						const before = this.table.getAllPeers().length;
						this.table.addPeer({
							id: n.id,
							addr,
							lastSeen: now,
						});
						const after = this.table.getAllPeers().length;
						if (after > before) addedAny = true;
					} catch {
						continue;
					}
				}
			}

			if (!addedAny) {
				log("bootstrapLookup: no new peers discovered, stopping");
				break;
			}
		}
	}

	/**
	 * Full iterative lookup for arbitrary targetId (slightly simplified).
	 */
	public async findNode(targetId: string): Promise<KadNodeInfo[]> {
		const visited = new Set<string>();
		let closest = this.table.getClosestPeers(targetId, this.cfg.k);
		let changed = true;

		while (changed) {
			const batch = closest
				.filter((p) => !visited.has(p.id))
				.slice(0, this.cfg.alpha);

			if (batch.length === 0) break;
			batch.forEach((p) => visited.add(p.id));

			const replies = await Promise.all(
				batch.map((p) => this.sendFindNodeUdp(p.addr, targetId)),
			);

			let addedAny = false;
			const now = Date.now();

			for (const nodes of replies) {
				for (const n of nodes) {
					try {
						const addr = multiaddr(n.addr);
						const before = this.table.getAllPeers().length;
						this.table.addPeer({
							id: n.id,
							addr,
							lastSeen: now,
						});
						const after = this.table.getAllPeers().length;
						if (after > before) addedAny = true;
					} catch {
						continue;
					}
				}
			}

			if (!addedAny) {
				changed = false;
			} else {
				closest = this.table.getClosestPeers(targetId, this.cfg.k);
			}
		}

		return this.table.getClosestPeers(targetId, this.cfg.k).map((p) => ({
			id: p.id,
			addr: p.addr.toString(),
		}));
	}

	// ---------- VALUE STORE / LOOKUP ----------

	private putLocal(key: string, value: any) {
		this.store.set(key, { value, storedAt: Date.now() });
	}

	public async putValue(key: string, value: any): Promise<void> {
		this.putLocal(key, value);

		const closest = this.table.getClosestPeers(key, this.cfg.k);
		if (closest.length === 0) return;

		await Promise.all(
			closest.map((p) => this.sendStoreUdp(p.addr, key, value)),
		);
	}

	public async findValue(key: string): Promise<any | null> {
		const local = this.store.get(key);
		if (local) return local.value;

		const seeds = this.table.getClosestPeers(key, this.cfg.alpha);
		if (seeds.length === 0) return null;

		const replies = await Promise.all(
			seeds.map((p) => this.sendFindValueUdp(p.addr, key)),
		);

		for (const r of replies) {
			if (r.value !== undefined) {
				this.putLocal(key, r.value);
				return r.value;
			}
		}

		const now = Date.now();
		for (const r of replies) {
			if (!r.nodes) continue;
			for (const n of r.nodes) {
				try {
					const addr = multiaddr(n.addr);
					this.table.addPeer({
						id: n.id,
						addr,
						lastSeen: now,
					});
				} catch {}
			}
		}

		return null;
	}

	// ---------- UDP handling ----------

	private async onUdpMessage(raw: any, rinfo: RemoteInfo) {
		const msg = raw as KadMessage;
		if (!msg || typeof msg !== "object" || !msg.type) return;

		// Track sender as a peer (id from msg.from, addr from rinfo).
		const remoteAddr = this.multiaddrFromUdp(rinfo);
		if (remoteAddr && msg.from) {
			this.table.addPeer({
				id: msg.from,
				addr: multiaddr(msg.from),
				lastSeen: Date.now(),
			});
		}

		// Check if this is a reply to a pending RPC
		if (msg.rpcId && this.pending.has(msg.rpcId)) {
			const pending = this.pending.get(msg.rpcId)!;
			this.pending.delete(msg.rpcId);

			clearTimeout(pending.timer);

			// ✅ NEW: ingest all nodes from NODES replies into the routing table
			if (msg.type === "NODES" && msg.nodes && msg.nodes.length > 0) {
				const now = Date.now();
				for (const n of msg.nodes) {
					try {
						const addr = multiaddr(n.addr);
						this.table.addPeer({
							id: n.id,
							addr,
							lastSeen: now,
						});
					} catch {
						// ignore bad multiaddrs
					}
				}
			}

			if (pending.type === "FIND_NODE" && msg.type === "NODES") {
				pending.resolve(msg.nodes);
				return;
			}

			if (pending.type === "FIND_VALUE") {
				if (msg.type === "VALUE") {
					pending.resolve({ value: msg.value });
					return;
				} else if (msg.type === "NODES") {
					pending.resolve({ nodes: msg.nodes });
					return;
				}
			}
			// fall through to normal handling too if you want
		}

		await this.handleKadMessage(msg, async (reply) => {
			const targetHost = rinfo.address;
			const targetPort = rinfo.port;
			if (msg.rpcId) {
				(reply as KadMessage).rpcId = msg.rpcId;
			}
			await this.udp.send(reply, targetHost, targetPort);
		});
	}

	private async handleKadMessage(
		msg: KadMessage,
		send: (reply: KadMessage) => Promise<void>,
	) {
		switch (msg.type) {
			case "PING": {
				await send({
					type: "PONG",
					from: this.localId,
				});
				break;
			}

			case "PONG":
				// could mark sender as alive; we already bump lastSeen above
				break;

			case "FIND_NODE": {
				const closest = this.table.getClosestPeers(msg.target, this.cfg.k);
				const nodes: KadNodeInfo[] = closest.map((p) => ({
					id: p.id.toString(),
					addr: p.addr.toString(),
				}));

				if (this.selfAddr) {
					nodes.push({
						id: this.localId,
						addr: this.selfAddr.toString(),
					});
				}

				await send({
					type: "NODES",
					from: this.localId,
					target: msg.target,
					nodes,
				});
				break;
			}

			case "NODES": {
				// Ingest all nodes we got back into the routing table
				if (msg.nodes && msg.nodes.length > 0) {
					const now = Date.now();
					for (const n of msg.nodes) {
						try {
							// n.addr is a string; turn it into a Multiaddr
							const addr = multiaddr(n.addr);

							// Avoid inserting obviously bogus / self entries if you want
							// if (n.id === this.peerId.toString()) continue;

							this.table.addPeer({
								id: n.id,
								addr,
								lastSeen: now,
							});
						} catch (err) {
							// Bad multiaddr etc – just ignore this entry
							log(
								`failed to add peer from NODES: id=${n.id} addr=${n.addr} err=${
									(err as Error).message
								}`,
							);
						}
					}
				}

				// You can still log it for debugging if you like
				// console.log("NODES msg:", msg);
				break;
			}

			case "STORE": {
				this.putLocal(msg.key, msg.value);
				log("STORE key=%s from=%s", msg.key, msg.from);
				break;
			}

			case "FIND_VALUE": {
				const local = this.store.get(msg.key);
				if (local) {
					await send({
						type: "VALUE",
						from: this.localId,
						key: msg.key,
						value: local.value,
					});
				} else {
					const closest = this.table.getClosestPeers(msg.key, this.cfg.k);
					const nodes: KadNodeInfo[] = closest.map((p) => ({
						id: p.id.toString(),
						addr: p.addr.toString(),
					}));

					if (this.selfAddr) {
						nodes.push({
							id: this.localId,
							addr: this.selfAddr.toString(),
						});
					}

					await send({
						type: "NODES",
						from: this.localId,
						target: msg.key,
						nodes,
					});
				}
				break;
			}

			case "VALUE":
				// handled as replies by caller
				break;
		}
	}

	// ---------- UDP outbound helpers ----------

	private genRpcId(): string {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}

	private async sendFindNodeUdp(
		addr: Multiaddr,
		target: string,
	): Promise<KadNodeInfo[]> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const rpcId = this.genRpcId();

		const msg: KadMessage = {
			type: "FIND_NODE",
			from: this.localId,
			target,
			rpcId,
		} as any;

		const nodes: KadNodeInfo[] = [];

		const promise = new Promise<KadNodeInfo[]>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(rpcId);
				resolve(nodes);
			}, 2_000);

			this.pending.set(rpcId, {
				type: "FIND_NODE",
				resolve,
				timer,
			});
		});

		await this.udp.send(msg, host, port);
		return promise;
	}

	private async sendStoreUdp(
		addr: Multiaddr,
		key: string,
		value: any,
	): Promise<void> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const msg: KadMessage = {
			type: "STORE",
			from: this.localId,
			key,
			value,
		} as any;

		try {
			await this.udp.send(msg, host, port);
		} catch (err) {
			log(`STORE UDP to ${addr.toString()} failed:`, err);
		}
	}

	private async sendFindValueUdp(
		addr: Multiaddr,
		key: string,
	): Promise<{ value?: any; nodes?: KadNodeInfo[] }> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const rpcId = this.genRpcId();

		const msg: KadMessage = {
			type: "FIND_VALUE",
			from: this.localId,
			key,
			rpcId,
		} as any;

		const promise = new Promise<{ value?: any; nodes?: KadNodeInfo[] }>(
			(resolve) => {
				const timer = setTimeout(() => {
					this.pending.delete(rpcId);
					resolve({});
				}, 2_000);

				this.pending.set(rpcId, {
					type: "FIND_VALUE",
					resolve,
					timer,
				});
			},
		);

		await this.udp.send(msg, host, port);
		return promise;
	}

	// ---------- helpers ----------

	private getHostPortFromMultiaddr(addr: Multiaddr): {
		host: string;
		port: number;
	} {
		const s = addr.toString(); // /ip4/127.0.0.1/tcp/4000/p2p/...
		const parts = s.split("/");
		const hostIdx = parts.indexOf("ip4") + 1;
		const tcpIdx = parts.indexOf("tcp") + 1;
		const host = parts[hostIdx] ?? "127.0.0.1";
		const port = parseInt(parts[tcpIdx] ?? "0", 10);
		return { host, port };
	}

	private multiaddrFromUdp(rinfo: RemoteInfo): Multiaddr | null {
		try {
			// We *assume* TCP and UDP share the same port in your dev setup.
			return multiaddr(`/ip4/${rinfo.address}/tcp/${rinfo.port}`);
		} catch {
			return null;
		}
	}

	private extractPeerId(addr: Multiaddr): string | null {
		try {
			const s = addr.toString();
			const parts = s.split("/p2p/");
			if (parts.length < 2) return null;
			return parts[1]!;
		} catch {
			return null;
		}
	}

	// ---------- inspection ----------

	public dumpRoutingTable(): KadRoutingTableDump {
		return this.table.dump();
	}

	public getKnownKadPeers(): KadNodeInfo[] {
		return this.table.getAllPeers().map((p) => ({
			id: p.id.toString(),
			addr: p.addr.toString(),
		}));
	}

	public async randomNodeLookup(rounds = 3) {
		for (let i = 0; i < rounds; i++) {
			const targetId = this.randomKadId();
			await this.findNode(targetId);
		}
	}

	private randomKadId(): string {
		const bytes = new Uint8Array(20);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
		return Buffer.from(bytes).toString("hex");
	}
}

export type { KadRoutingTableDump };
