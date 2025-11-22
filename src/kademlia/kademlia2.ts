export class KademliaRoutingTable {}

import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { RemoteInfo } from "dgram";
import type { PeerNode } from "../node";
import type { PeerId } from "../session/nodeInfo";
import { KadUdpTransport } from "./kad-udp-transport";
import {
	type KadPeer,
	type KadRoutingTableDump,
	RoutingTable,
} from "./routing-table";
import type {
	KademliaConfig,
	KadMessage,
	KadNodeInfo,
	PendingRpc,
	StoredValue,
} from "./types";

const log = debug("p2p:kad");

export class KademliaDHT {
	private readonly node: PeerNode;
	private readonly peerId: PeerId;
	private readonly cfg: KademliaConfig;
	private readonly table: RoutingTable;
	private readonly store = new Map<string, StoredValue>();

	private udp: KadUdpTransport;
	private pending = new Map<string, PendingRpc>();

	constructor(node: PeerNode, cfg?: Partial<KademliaConfig>) {
		this.node = node;
		this.peerId = node.peerId;
		this.cfg = {
			k: cfg?.k ?? 16,
			alpha: cfg?.alpha ?? 4,
			maxBuckets: cfg?.maxBuckets ?? 256,
			pendingTimeoutMs: cfg?.pendingTimeoutMs ?? 5_000,
		};

		this.table = new RoutingTable(
			this.peerId.toString(),
			this.cfg.k,
			this.cfg.maxBuckets,
			this.cfg.pendingTimeoutMs,
		);

		this.table.onPendingEviction = (victim: KadPeer) => {
			this.handleBucketPendingEviction(victim).catch((err) =>
				log("error handling pending eviction ping:", err),
			);
		};

		const { host, port } = this.parseHostPort(node.address);
		this.udp = new KadUdpTransport(host, port, (msg, rinfo) =>
			this.onUdpMessage(msg, rinfo),
		);
	}

	public noteConnectedPeer(addr: Multiaddr) {
		const idStr = this.extractPeerId(addr);
		if (!idStr) return;

		this.table.addPeer(
			{
				id: idStr,
				addr,
				lastSeen: Date.now(),
			},
			"connected",
		);
	}

	public addBootstrapPeers(addrs: Multiaddr[]) {
		const now = Date.now();
		for (const addr of addrs) {
			const idStr = this.extractPeerId(addr);
			if (!idStr) continue;
			this.table.addPeer(
				{
					id: idStr,
					addr,
					lastSeen: now,
				},
				"connected",
			);
		}
	}

	public async bootstrapLookup(maxRounds = 3): Promise<void> {
		if (this.table.getAllPeers().length === 0) {
			log("bootstrapLookup: no peers in table, did you add bootstraps?");
			return;
		}

		const visited = new Set<string>();
		let round = 0;

		while (round < maxRounds) {
			round++;

			const frontier = this.table.getClosestPeers(
				this.peerId.toString(),
				this.cfg.k,
			);

			if (frontier.length === 0) {
				log("bootstrapLookup: frontier exhausted");
				break;
			}

			frontier.forEach((p) => visited.add(p.id));
			log(`bootstrapLookup: round=${round}, querying ${frontier.length} peers`);

			const replies = await Promise.all(
				frontier.map((p) =>
					this.sendFindNodeUdp(p.addr, this.peerId.toString()),
				),
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
					} catch {}
				}
			}

			if (!addedAny) {
				log("bootstrapLookup: no new peers discovered, stopping");
				break;
			}
		}
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

	// ---------- node lookup ----------

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

			for (const nodes of replies) {
				for (const n of nodes) {
					try {
						const addr = multiaddr(n.addr);
						const before = this.table.getAllPeers().length;
						this.table.addPeer(
							{
								id: n.id,
								addr,
								lastSeen: Date.now(),
							},
							"questionable",
						);
						const after = this.table.getAllPeers().length;
						if (after > before) addedAny = true;
					} catch {}
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
					this.table.addPeer(
						{
							id: n.id,
							addr,
							lastSeen: Date.now(),
						},
						"questionable",
					);
				} catch {}
			}
		}

		return null;
	}

	private async onUdpMessage(raw: any, rinfo: RemoteInfo) {
		const msg = raw as KadMessage;
		if (!msg || typeof msg !== "object" || !msg.type) return;

		if (msg.from) {
			const base = this.multiaddrFromUdp(rinfo);
			if (base) {
				const full = multiaddr(`${base.toString()}/p2p/${msg.from}`);
				this.table.addPeer(
					{
						id: msg.from,
						addr: full,
						lastSeen: Date.now(),
					},
					"connected",
				);
			}
		}

		if (msg.rpcId && this.pending.has(msg.rpcId)) {
			const pending = this.pending.get(msg.rpcId)!;
			this.pending.delete(msg.rpcId);
			clearTimeout(pending.timer);

			if (pending.type === "FIND_NODE" && msg.type === "NODES") {
				pending.resolve(msg.nodes);
			} else if (pending.type === "FIND_VALUE") {
				if (msg.type === "VALUE") {
					pending.resolve({ value: msg.value });
				} else if (msg.type === "NODES") {
					pending.resolve({ nodes: msg.nodes });
				}
			} else if (pending.type === "PING" && msg.type === "PONG") {
				pending.resolve(true);
				if (msg.from) {
					this.table.setPeerStatus(msg.from, "connected");
				}
			}
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
					from: this.peerId.toString(),
				});
				break;
			}

			case "PONG": {
				if (msg.from) {
					this.table.setPeerStatus(msg.from, "connected");
				}
				break;
			}

			case "FIND_NODE": {
				const closest = this.table.getClosestPeers(msg.target, this.cfg.k);
				const nodes: KadNodeInfo[] = closest.map((p) => ({
					id: p.id.toString(),
					addr: p.addr.toString(),
				}));

				nodes.push({
					id: this.peerId.toString(),
					addr: this.node.address.toString(),
				});

				await send({
					type: "NODES",
					from: this.peerId.toString(),
					target: msg.target,
					nodes,
				});
				break;
			}

			case "NODES": {
				if (msg.nodes && msg.nodes.length > 0) {
					const now = Date.now();
					for (const n of msg.nodes) {
						try {
							const addr = multiaddr(n.addr);
							this.table.addPeer(
								{
									id: n.id,
									addr,
									lastSeen: now,
								},
								"questionable",
							);
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
						from: this.peerId.toString(),
						key: msg.key,
						value: local.value,
					});
				} else {
					const closest = this.table.getClosestPeers(msg.key, this.cfg.k);
					const nodes: KadNodeInfo[] = closest.map((p) => ({
						id: p.id.toString(),
						addr: p.addr.toString(),
					}));
					nodes.push({
						id: this.peerId.toString(),
						addr: this.node.address.toString(),
					});

					await send({
						type: "NODES",
						from: this.peerId.toString(),
						target: msg.key,
						nodes,
					});
				}
				break;
			}

			case "VALUE":
				break;
		}
	}

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

	private async sendPingUdp(addr: Multiaddr): Promise<boolean> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const rpcId = this.genRpcId();

		const msg: KadMessage = {
			type: "PING",
			from: this.peerId.toString(),
			rpcId,
		} as any;

		const promise = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(rpcId);
				resolve(false);
			}, 2_000);

			this.pending.set(rpcId, {
				type: "PING",
				resolve,
				timer,
			});
		});

		await this.udp.send(msg, host, port);
		return promise;
	}

	private async sendFindNodeUdp(
		addr: Multiaddr,
		target: string,
	): Promise<KadNodeInfo[]> {
		const { host, port } = this.getHostPortFromMultiaddr(addr);
		const rpcId = this.genRpcId();

		const msg: KadMessage = {
			type: "FIND_NODE",
			from: this.peerId.toString(),
			target,
			rpcId,
		} as any;

		const promise = new Promise<KadNodeInfo[]>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(rpcId);
				resolve([]);
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
			from: this.peerId.toString(),
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
			from: this.peerId.toString(),
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

	private parseHostPort(addr: Multiaddr): { host: string; port: number } {
		return this.getHostPortFromMultiaddr(addr);
	}

	private multiaddrFromUdp(rinfo: RemoteInfo): Multiaddr | null {
		try {
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

	private async handleBucketPendingEviction(victim: KadPeer) {
		try {
			const ok = await this.sendPingUdp(victim.addr);
			if (ok) {
				this.table.addPeer(
					{
						...victim,
						lastSeen: Date.now(),
					},
					"connected",
				);
			}
		} catch (err) {
			log("error pinging victim during pending eviction:", err);
		}
	}
	public removePeer(id: string) {
		this.table.removePeer(id);
	}

	public pruneStalePeers(maxAgeMs = 120_000, onlyQuestionable = true) {
		const removed = this.table.pruneStale(maxAgeMs, onlyQuestionable);
		if (removed.length) {
			log(
				`pruned %d stale kad peers (older than %d ms)`,
				removed.length,
				maxAgeMs,
			);
		}
	}

	public async pingRandomPeers(count = 4) {
		const peers = this.table.getAllPeers();
		await Promise.all(
			peers.map(async (p) => {
				try {
					const ok = await this.sendPingUdp(p.addr);
					if (!ok) {
						this.table.removePeer(p.id);
						log(`kad: removed peer %s due to ping timeout`, p.id);
					} else {
						this.table.addPeer({ ...p, lastSeen: Date.now() }, "connected");
					}
				} catch {
					this.table.removePeer(p.id);
					log(`kad: removed peer %s due to ping error`, p.id);
				}
			}),
		);
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
