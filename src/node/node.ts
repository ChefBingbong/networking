// src/node/node.ts
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import { EventEmitter } from "events";
import type { MuxedConnection } from "../connection/connection";
import type { ProtocolHandler } from "../connection/protocol-manager";
import { ProtocolManager } from "../connection/protocol-manager";
import { createKadApi } from "../http/api";
import { KademliaNode as KademliaDHT } from "../kademlia/kademlia";
import { idToKey } from "../kademlia/xor";
import type { Packet } from "../packet/types";
import { loopInterval } from "../secp256k1/utils";
import type { PeerId, PeerInfo } from "../session/nodeInfo";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { safeError, safeResult } from "../utils/safe";
import { getHostPortFromMultiaddr } from "../utils/utils";
import { CoreMessageHandler } from "./core-handler";
import { BOOTSTRAP_ADDRS } from "./createNode"; // Multiaddr[]
import type { TransportListener } from "./transport";
import { MessageRouter } from "./transport/message-router";
import { Transport } from "./transport/transport";
import type { NodeMetrics, NodeMetricsSnapshot } from "./types";

const log = debug("p2p:node");

const DIAL_BACKOFF_MS = 5_000;

export class PeerNode extends EventEmitter {
	public metrics: NodeMetrics = {
		firstConnectLatencies: new Map(),
		pingLatencies: [],
	};

	private transport: Transport;
	public connections = new Map<string, MuxedConnection>();

	public peerId: PeerId;
	public address: Multiaddr;
	private listener: TransportListener;
	private coreHandler: CoreMessageHandler;
	public kad: KademliaDHT;

	private router: MessageRouter;
	public protocolManager: ProtocolManager;
	public nodeOptions: PeerInfo;

	private failedPeers = new Map<string, number>();

	constructor(nodeOptions: PeerInfo) {
		super();
		this.nodeOptions = nodeOptions;
		this.transport = new Transport(nodeOptions.privateKey, {
			maxActiveDials: 50,
		});
		this.peerId = peerIdFromPrivateKey(nodeOptions.privateKey);

		this.address = multiaddr(
			`/ip4/${nodeOptions.host}/tcp/${nodeOptions.port}/p2p/${this.peerId.toString()}`,
		);

		this.protocolManager = new ProtocolManager();
		this.coreHandler = new CoreMessageHandler(this);

		this.kad = new KademliaDHT(this, idToKey(this.peerId.toString()), {
			k: 16,
			alpha: 6,
			idBits: 160,
			lookupTimeoutMs: 500,
			port: nodeOptions.port, // UDP bind port
		});

		this.router = new MessageRouter();
		this.router.register(this.protocolManager.handle);
		this.router.register(this.coreHandler.handle);

		this.listener = this.transport.createListener({
			frameHandler: this.router.handle,
			streamOpenHandler: (protocol, stream) =>
				this.protocolManager.onIncomingStream(protocol, stream),
		});

		createKadApi(this, 4000 + nodeOptions.port);
	}

	public async start() {
		try {
			log(
				`starting node ${this.peerId.toString()} at ${this.address.toString()}`,
			);
			await this.startListening();
			await this.kadBootstrap();
			this.runContactLoop(); // now real periodic lookups + pings
		} catch (error) {
			log(`Failed to start ${String(this.address)}`);
			throw error;
		}
	}

	private startListening() {
		return this.listener.listen(this.address);
	}

	public async dial(addrKey: string) {
		try {
			const mAddr = multiaddr(addrKey);
			const conn = await this.getExistingOrNewConnection(mAddr, true);
			return safeResult(conn);
		} catch (error) {
			return safeError(error);
		}
	}

	public async dialProtocol(addr: Multiaddr, protocol: string) {
		try {
			const connection = await this.getExistingOrNewConnection(addr, true);
			return await this.protocolManager.initOutgoing(connection, protocol);
		} catch (error) {
			log(`Failed to dial protocol ${protocol} on ${String(addr)}`);
			throw error;
		}
	}

	public handleProtocol(protocol: string, handler: ProtocolHandler) {
		this.protocolManager.register(protocol, handler);
	}

	public getMetricsSnapshot(): NodeMetricsSnapshot {
		const firstVals = [...this.metrics.firstConnectLatencies.values()];
		const pingVals = this.metrics.pingLatencies;

		const avg = (xs: number[]) =>
			xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

		return {
			nodeId: this.peerId.toString(),
			address: this.address.toString(),
			uniquePeers: this.connections.size,
			firstConnectCount: firstVals.length,
			firstConnectAvgMs: avg(firstVals),
			pingCount: pingVals.length,
			pingAvgMs: avg(pingVals),
		};
	}

	public getKadPeers() {
		return this.kad.table.allContacts().map((c) => c.addr);
	}

	public async kadBootstrap() {
		// Seed from static bootstrap addresses
		await this.kad.bootstrap(
			BOOTSTRAP_ADDRS.map((addr) => {
				const ma = multiaddr(addr);
				const { host, port } = getHostPortFromMultiaddr(ma);
				return {
					id: idToKey(this.extractPeerIdFromMultiaddr(ma) || ma.toString()),
					addr: ma.toString(),
					host,
					port,
					lastSeen: Date.now(),
				};
			}),
		);
	}

	/**
	 * Periodic Kademlia maintenance:
	 *  - lookup on our own ID (refresh buckets near us)
	 *  - random lookups (discover new peers, refresh far buckets)
	 *  - random pings (liveness maintenance)
	 */
	private runContactLoop() {
		// Refresh own ID region every ~60s
		loopInterval(async () => {
			await this.kad.refreshSelf();
		}, this.withJitter(8_000));

		// Random node lookup every ~30s
		loopInterval(async () => {
			const target = this.kad.randomNodeId();
			await this.kad.nodeLookup(target);
		}, this.withJitter(10_000));

		// Ping random contacts every ~20s
		loopInterval(async () => {
			await this.kad.pingRandom(8);
		}, this.withJitter(10_000));
	}

	public async connectToKadPeers() {
		// Optionally: dial TCP to DHT-known peers
		const kadContacts = this.kad.table.allContacts();
		for (const c of kadContacts) {
			try {
				await this.dial(c.addr);
			} catch {
				// best-effort; ignore failures
			}
		}
	}

	private async getExistingOrNewConnection(
		mAddr: Multiaddr,
		storeConnection = true,
		timeoutMs = 60_000,
	) {
		const key = mAddr.toString();

		const existing = this.connections.get(key);
		if (existing) return existing;

		if (!this.canDialPeer(mAddr)) {
			throw new Error(`backing off dial to ${key}`);
		}

		const start = Date.now();
		const [error, dialedConn] = await this.transport.dial(mAddr, timeoutMs);
		const elapsed = Date.now() - start;

		if (error) {
			this.markDialFailure(mAddr);
			throw error;
		}

		if (!this.metrics.firstConnectLatencies.has(key)) {
			this.metrics.firstConnectLatencies.set(key, elapsed);
		}

		if (!storeConnection) return dialedConn;
		return this.attachConnectionHandlers(mAddr, dialedConn);
	}

	private attachConnectionHandlers(addr: Multiaddr, conn: MuxedConnection) {
		const key = addr.toString();
		this.connections.set(key, conn);
		log(`connection established to ${key} (total: ${this.connections.size})`);

		// Feed this TCP-connected peer into Kademlia as a contact
		const remotePeerId = this.extractPeerIdFromMultiaddr(addr);
		if (remotePeerId) {
			const { host, port } = getHostPortFromMultiaddr(addr);
			this.kad
				.noteContact({
					id: idToKey(remotePeerId),
					addr: addr.toString(),
					host,
					port,
				})
				.catch((err) => {
					log(
						`failed to note kad contact for ${key}: ${
							(err as Error).message ?? String(err)
						}`,
					);
				});
		}

		conn.setOnFrame((frame: Packet) => {
			this.router.handle(conn, frame);
		});

		conn.setOnStreamOpen((protocol, stream) => {
			this.protocolManager.onIncomingStream(protocol, stream);
		});

		conn.socket.once("close", () => {
			this.connections.delete(key);
			this.protocolManager.onConnectionClosed(conn);
			log(`connection to ${key} closed (total: ${this.connections.size})`);
			// Optional: you could also mark Kademlia contact as "questionable" here
		});

		return conn;
	}

	private extractPeerIdFromMultiaddr(addr: Multiaddr): string | null {
		try {
			const s = addr.toString();
			const parts = s.split("/p2p/");
			if (parts.length < 2) return null;
			return parts[1]!;
		} catch {
			return null;
		}
	}

	private canDialPeer(addr: Multiaddr): boolean {
		const key = addr.toString();
		const now = Date.now();
		const nextAllowed = this.failedPeers.get(key);
		if (nextAllowed && now < nextAllowed) {
			return false;
		}
		return true;
	}

	private markDialFailure(addr: Multiaddr) {
		const key = addr.toString();
		const next = Date.now() + DIAL_BACKOFF_MS;
		this.failedPeers.set(key, next);
	}

	private withJitter(baseMs: number, jitterFraction = 0.2) {
		const delta = baseMs * jitterFraction;
		return baseMs + (Math.random() * 2 - 1) * delta;
	}
}
