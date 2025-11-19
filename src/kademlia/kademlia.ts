// src/kademlia/kademlia.ts

import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { RemoteInfo } from "dgram";
import type { PeerNode } from "../node";
import { KadUdpTransport } from "./kad-udp-transport";
import { type KadRoutingTableDump, RoutingTable } from "./routing-table";
import { xorDistance } from "./xor";

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
	private readonly node: PeerNode;
	private readonly localId: string;
	private readonly cfg: KademliaConfig;
	private readonly table: RoutingTable;
	private readonly store = new Map<string, StoredValue>();

	// UDP transport
	private udp: KadUdpTransport;

	// pending RPCs keyed by rpcId
	private pending = new Map<string, PendingRpc>();

	// maintenance
	private maintenanceRunning = false;
	private readonly staleAfterMs = 60000; // consider peers stale after 60s of no traffic

	constructor(node: PeerNode, cfg?: Partial<KademliaConfig>) {
		this.node = node;
		this.localId = node.peerId.toString();
		this.cfg = {
			k: cfg?.k ?? 16,
			alpha: cfg?.alpha ?? 5,
			maxBuckets: cfg?.maxBuckets ?? 256,
		};
		this.table = new RoutingTable(
			this.localId,
			this.cfg.k,
			this.cfg.maxBuckets,
		);

		const { host, port } = this.parseHostPort(node.address);
		this.udp = new KadUdpTransport(host, port, (msg, rinfo) =>
			this.onUdpMessage(msg, rinfo),
		);
	}

	// ---------- integration hooks from PeerNode ----------

	public noteConnectedPeer(addr: Multiaddr) {
		const idStr = this.extractPeerId(addr);
		if (!idStr) return;
		this.table.addPeer({
			id: idStr,
			addr,
			lastSeen: Date.now(),
			status: "connected",
		});
	}

	public addBootstrapPeers(addrs: Multiaddr[]) {
		const now = Date.now();
		for (const addr of addrs) {
			const idStr = this.extractPeerId(addr);
			if (!idStr) continue;
			this.table.addPeer({
				id: idStr,
				addr,
				lastSeen: now,
				status: "questionable",
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
							status: "connected",
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
							status: "connected",
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

	// ---------- inspection APIs ----------

	public dumpRoutingTable(): KadRoutingTableDump {
		return this.table.dump();
	}

	public getKnownKadPeers(): KadNodeInfo[] {
		return this.table.getAllPeers().map((p) => ({
			id: p.id.toString(),
			addr: p.addr.toString(),
		}));
	}

	public getPeerCount(): number {
		return this.table.getAllPeers().length;
	}

	// ---------- node lookup (iterative) ----------

	private isCloser(targetId: string, aId: string, bId: string): boolean {
		const da = xorDistance(aId, targetId);
		const db = xorDistance(bId, targetId);
		return Buffer.compare(da, db) < 0;
	}

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

		for (const r of replies) {
			if (!r.nodes) continue;
			for (const n of r.nodes) {
				try {
					const addr = multiaddr(n.addr);
					this.table.addPeer({
						id: n.id,
						addr,
						lastSeen: Date.now(),
						status: "connected",
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

		let handledByPending = false;
		if (msg.from) {
			this.table.addPeer({
				id: msg.from,
				addr: multiaddr(`${this.multiaddrFromUdp(rinfo)}/p2p/${msg.from}`),
				lastSeen: Date.now(),
				status: "connected",
			});
		}

		// Check if this is a reply to a pending RPC
		if (msg.rpcId && this.pending.has(msg.rpcId)) {
			const pending = this.pending.get(msg.rpcId)!;
			this.pending.delete(msg.rpcId);

			clearTimeout(pending.timer);

			if (pending.type === "FIND_NODE" && msg.type === "NODES") {
				pending.resolve(msg.nodes);
				handledByPending = true;
			}

			if (pending.type === "FIND_VALUE") {
				if (msg.type === "VALUE") {
					pending.resolve({ value: msg.value });
					handledByPending = true;
				} else if (msg.type === "NODES") {
					pending.resolve({ nodes: msg.nodes });
					handledByPending = true;
				}
			}
			// IMPORTANT: no return here – we still fall through
		}

		// Optional: liveness mark based on msg.from
		if (msg.from) {
			this.table.markPeerAlive(msg.from);
		}

		// normal Kad behaviour (respond to requests / ingest nodes)
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

			case "PONG": {
				this.table.markPeerAlive(msg.from);
				// We've already markPeerAlive in onUdpMessage via msg.from
				break;
			}

			case "FIND_NODE": {
				const closest = this.table.getClosestPeers(msg.target, this.cfg.k);
				const nodes: KadNodeInfo[] = closest.map((p) => ({
					id: p.id.toString(),
					addr: p.addr.toString(),
				}));
				// Include ourselves
				nodes.push({
					id: this.localId,
					addr: this.node.address.toString(),
				});

				await send({
					type: "NODES",
					from: this.localId,
					target: msg.target,
					nodes,
				});
				break;
			}

			case "NODES": {
				// Even if it wasn't a response we awaited, ingest into the table
				if (msg.nodes && msg.nodes.length > 0) {
					const now = Date.now();
					for (const n of msg.nodes) {
						try {
							const addr = multiaddr(n.addr);
							this.table.addPeer({
								id: n.id,
								addr,
								lastSeen: now,
								status: "questionable",
							});
						} catch (err) {
							log(
								`failed to add peer from NODES: id=${n.id} addr=${n.addr} err=${
									(err as Error).message
								}`,
							);
						}
					}
				}
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
					console.log("FIND_VALUE NODES:", nodes);
					nodes.push({
						id: this.localId,
						addr: this.node.address.toString(),
					});

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
				// handled mainly via pending FIND_VALUE
				break;
		}
	}

	// ---------- UDP outbound helpers ----------

	private genRpcId(): string {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}

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

	private async sendPingUdp(addr: Multiaddr): Promise<void> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const msg: KadMessage = {
			type: "PING",
			from: this.localId,
		};
		try {
			await this.udp.send(msg, host, port);
		} catch (err) {
			log(`PING UDP to ${addr.toString()} failed:`, err);
		}
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

	private multiaddrFromUdp(rinfo: RemoteInfo): Multiaddr | null {
		try {
			// We *assume* TCP and UDP share the same port in your dev setup.
			return multiaddr(`/ip4/${rinfo.address}/tcp/${rinfo.port}`);
		} catch {
			return null;
		}
	}
	// ---------- maintenance helpers ----------

	public async randomNodeLookup(rounds = 3) {
		for (let i = 0; i < rounds; i++) {
			const targetId = this.randomKadId();
			await this.findNode(targetId);
		}
	}

	private randomKadId(): string {
		// random 160-bit hex string
		const bytes = new Uint8Array(20);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
		return Buffer.from(bytes).toString("hex");
	}

	/**
	 * One "maintenance tick" – ping some stale peers and perform one random lookup.
	 * Call this periodically from PeerNode.
	 */
	public async maintenanceTick() {
		if (this.maintenanceRunning) return;
		this.maintenanceRunning = true;
		try {
			// 1) ping stale peers to refresh liveness
			const stale = this.table.getStalePeers(this.staleAfterMs, this.cfg.alpha);
			await Promise.all(stale.map((p) => this.sendPingUdp(p.addr)));

			// 2) choose a target for FIND_NODE
			const randomPeers = this.table.getRandomPeers(1);
			if (randomPeers.length > 0) {
				// look for nodes near a random known peer
				await this.findNode(randomPeers[0]!.id);
			} else {
				// or completely random if table empty-ish
				await this.randomNodeLookup(1);
			}
		} finally {
			this.maintenanceRunning = false;
		}
	}

	// ---------- helpers ----------

	private parseHostPort(addr: Multiaddr): { host: string; port: number } {
		return this.getHostPortFromMultiaddr(addr);
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
}

export type { KadRoutingTableDump };
