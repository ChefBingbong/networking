import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { RemoteInfo } from "dgram";
import type { PeerNode } from "../node"; // adjust path if needed
import type { PeerId } from "../session/nodeInfo";
import { KadUdpTransport } from "./kad-udp-transport";
import { type KadRoutingTableDump, RoutingTable } from "./routing-table";
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
			alpha: cfg?.alpha ?? 3,
			maxBuckets: cfg?.maxBuckets ?? 256,
		};
		this.table = new RoutingTable(
			this.peerId.toString(),
			this.cfg.k,
			this.cfg.maxBuckets,
		);

		const { host, port } = this.parseHostPort(node.address);
		this.udp = new KadUdpTransport(host, port, (msg, rinfo) =>
			this.onUdpMessage(msg, rinfo),
		);
	}

	public noteConnectedPeer(addr: Multiaddr) {
		const idStr = this.extractPeerId(addr);
		if (!idStr) return;
		this.table.addPeer({
			id: idStr,
			addr,
			lastSeen: Date.now(),
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
			});
		}
	}

	public async bootstrapLookup() {
		const closest = this.table.getClosestPeers(
			this.peerId.toString(),
			this.cfg.alpha,
		);
		await Promise.all(
			closest.map((p) => this.sendFindNodeUdp(p.addr, this.peerId.toString())),
		);
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

	public async findNode(targetId: string): Promise<KadNodeInfo[]> {
		const seeds = this.table.getClosestPeers(targetId, this.cfg.alpha);
		const results: KadNodeInfo[] = [];
		if (seeds.length === 0) return results;

		const replies = await Promise.all(
			seeds.map((p) => this.sendFindNodeUdp(p.addr, targetId)),
		);

		for (const nodes of replies) {
			results.push(...nodes);
		}

		for (const n of results) {
			try {
				const addr = multiaddr(n.addr);
				this.noteConnectedPeer(addr);
			} catch {}
		}

		return results;
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
					this.noteConnectedPeer(addr);
				} catch {}
			}
		}

		return null;
	}

	private async onUdpMessage(raw: any, rinfo: RemoteInfo) {
		const msg = raw as KadMessage;
		if (!msg || typeof msg !== "object" || !msg.type) return;

		// Check if this is a reply to a pending RPC
		if (msg.rpcId && this.pending.has(msg.rpcId)) {
			const pending = this.pending.get(msg.rpcId)!;
			this.pending.delete(msg.rpcId);

			clearTimeout(pending.timer);

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
		}

		const remoteAddr = this.multiaddrFromUdp(rinfo);
		if (remoteAddr) {
			this.noteConnectedPeer(remoteAddr);
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

			case "PONG":
				break;

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

			case "NODES":
				break;

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
			// we don't know peerId from UDP alone – but we can still track addr
			return multiaddr(`/ip4/${rinfo.address}/udp/${rinfo.port}`);
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
