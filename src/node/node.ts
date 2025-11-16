import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import { EventEmitter } from "events";
import { Rendezvous } from "../discovery/rendevous/rendevous";
import {
	mkBroadcastAdvert,
	mkDiscoveryRequest,
	mkPing,
} from "../packet/packets";
import type { Packet } from "../packet/types";
import type { ProtocolHandler } from "../protocol/protocol-manager";
import { ProtocolManager } from "../protocol/protocol-manager";
import type { PeerId, PeerInfo } from "../session/nodeInfo";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { safeError, safeResult } from "../utils/safe";
import type { MuxedConnection } from "./connection";
import { CoreMessageHandler } from "./core-handler";
import type { TransportListener } from "./transport";
import { MessageRouter } from "./transport/message-router";
import { Transport } from "./transport/transport";

const log = debug("p2p:node");

// target degree band
const DEGREE_MIN = 12;
const DEGREE_MAX = 16;

// backoff for failing peers (ms)
const DIAL_BACKOFF_MS = 5_000;

type NodeMetrics = {
	firstConnectLatencies: Map<string, number>; // per-peer first connect ms
	pingLatencies: number[]; // ms
};

export type NodeMetricsSnapshot = {
	nodeId: string;
	address: string;
	uniquePeers: number;
	firstConnectCount: number;
	firstConnectAvgMs: number;
	pingCount: number;
	pingAvgMs: number;
};

export class PeerNode extends EventEmitter {
	public metrics: NodeMetrics = {
		firstConnectLatencies: new Map(),
		pingLatencies: [],
	};

	private transport: Transport;
	private rendezvous: Rendezvous;
	public connections = new Map<string, MuxedConnection>();

	public peerId: PeerId;
	public address: Multiaddr;
	private listener: TransportListener;
	private coreHandler: CoreMessageHandler;

	private router: MessageRouter;
	public protocolManager: ProtocolManager;
	public nodeOptions: PeerInfo;

	// NEW: dial backoff tracking
	private failedPeers = new Map<string, number>(); // addrKey -> nextAllowedDialTs

	constructor(nodeOptions: PeerInfo) {
		super();
		this.nodeOptions = nodeOptions;
		this.transport = new Transport(nodeOptions.privateKey);
		this.peerId = peerIdFromPrivateKey(nodeOptions.privateKey);

		this.address = multiaddr(
			`/ip4/${nodeOptions.host}/tcp/${nodeOptions.port}/p2p/${this.peerId.toString()}`,
		);

		this.rendezvous = new Rendezvous(nodeOptions);
		this.protocolManager = new ProtocolManager();
		this.coreHandler = new CoreMessageHandler(this);

		this.router = new MessageRouter();
		this.router.register(this.protocolManager.handle);
		this.router.register(this.rendezvous.handle);
		this.router.register(this.coreHandler.handle);

		this.listener = this.transport.createListener(
			this.router.handle,
			(protocol, stream) => {
				// Forward STREAM_OPEN to ProtocolManager
				this.protocolManager.onIncomingStream(protocol, stream);
			},
		);
	}

	// ---------- lifecycle ----------

	public async start() {
		try {
			await this.startListening();
			this.runAdvertLoop();
			this.runDiscoveryLoop();
			this.runContactLoop();
		} catch (error) {
			log(`Failed to start ${String(this.address)}`);
			throw error;
		}
	}

	private startListening() {
		return this.listener.listen(this.address);
	}

	// ---------- public API ----------

	public async dial(addrKey: string) {
		try {
			const mAddr = multiaddr(addrKey);
			const conn = await this.getExistingOrNewConnection(mAddr, true, 10_000);
			return safeResult(conn);
		} catch (error) {
			return safeError(error);
		}
	}

	public async dialProtocol(addr: Multiaddr, protocol: string) {
		try {
			const connection = await this.getExistingOrNewConnection(
				addr,
				true,
				5_000,
			);
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

	private getCurrentDegree() {
		return this.connections.size;
	}

	// ---------- backoff helpers ----------

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

	// ---------- rendezvous / discovery ----------

	public async broadcastAdvert() {
		this.rendezvous.refreshAdvertIfNeeded();
		const advert = this.rendezvous.getCurrentAdvert();

		const targets = this.rendezvous
			.getAdvertBroadcastTargets()
			.filter(
				(addr) =>
					!this.connections.has(addr.toString()) &&
					!addr.toString().includes(this.nodeOptions.port.toString()),
			);

		targets.forEach(async (addr) => {
			try {
				// adverts are "best effort" → short timeout, don't store connection
				const conn = await this.getExistingOrNewConnection(
					addr,
					false,
					500, // ms
				);
				conn.send(mkBroadcastAdvert(JSON.stringify(advert)));
				log(`📢 Advert sent to ${addr.toString()}`);
			} catch {
				// ignore
			}
		});
	}

	/**
	 * Discovery:
	 * - Only runs when degree < DEGREE_MIN.
	 * - Uses short timeouts, does not persist connections necessarily.
	 */
	public async discoverPeers(maxNewConnections = 50) {
		const degree = this.getCurrentDegree();
		if (degree >= DEGREE_MIN) {
			return; // good enough, skip active discovery
		}

		const remainingBudget = Math.max(0, DEGREE_MAX - degree);
		if (remainingBudget === 0) return;

		this.rendezvous.refreshAdvertIfNeeded();

		const targets = this.rendezvous
			.getDiscoveryTargets(Math.min(maxNewConnections, remainingBudget))
			.filter(
				(addr) =>
					!this.connections.has(addr.toString()) &&
					!addr.toString().includes(this.nodeOptions.port.toString()),
			);

		if (targets.length === 0) return;

		const slots = this.rendezvous.getDiscoverySlots();

		targets.forEach(async (addr) => {
			try {
				const conn = await this.getExistingOrNewConnection(
					addr,
					false,
					250, // short probe timeout
				);
				conn.send(mkDiscoveryRequest(slots, this.address.toString()));
				log(`Sent DISCOVERY_REQUEST to ${addr.toString()}`);
			} catch {
				// ignore
			}
		});
	}

	/**
	 * Connect to peers we learned via adverts.
	 * Same degree band logic as discoverPeers, but with longer timeouts & stored connections.
	 */
	public async connectToAdvertisedPeers(maxNewConnections = 50) {
		const degree = this.getCurrentDegree();
		if (degree >= DEGREE_MIN) {
			return;
		}

		const remainingBudget = Math.max(0, DEGREE_MAX - degree);
		if (remainingBudget === 0) return;

		const allAdverts = this.rendezvous.getKnownAdvertPeers();

		const candidates = allAdverts.filter((addr) => {
			const key = addr.toString();
			if (key.includes(this.nodeOptions.port.toString())) return false; // self
			if (this.connections.has(key)) return false; // already connected
			return true;
		});

		const toDial = candidates.slice(
			0,
			Math.min(maxNewConnections, remainingBudget),
		);

		for (const addr of toDial) {
			try {
				const conn = await this.getExistingOrNewConnection(addr, true, 5_000);
				conn.send(mkPing(this.address.toString()));
				log(`Connected to ${addr.toString()} (from adverts)`);
			} catch {
				// ignore
			}
		}
	}

	// ---------- connection management ----------

	private async getExistingOrNewConnection(
		mAddr: Multiaddr,
		storeConnection = true,
		timeoutMs = 10_000,
	): Promise<MuxedConnection> {
		const key = mAddr.toString();

		const existing = this.connections.get(key);
		if (existing) return existing;

		if (!this.canDialPeer(mAddr)) {
			throw new Error(`backing off dial to ${key}`);
		}

		const start = Date.now();
		const [error, dialedConn] = await this.transport.dial(
			mAddr,
			timeoutMs,
			true,
		);
		const elapsed = Date.now() - start;

		if (error || !dialedConn) {
			this.markDialFailure(mAddr);
			throw error ?? new Error(`dial failed to ${key}`);
		}

		// record first-connect latency once per peer
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

		// route non-stream frames to router
		conn.setOnFrame((frame: Packet) => {
			this.router.handle(conn, frame);
		});

		// mux: route incoming streams into ProtocolManager
		conn.setOnStreamOpen((protocol, stream) => {
			this.protocolManager.onIncomingStream(protocol, stream);
		});

		conn.socket.once("close", () => {
			this.connections.delete(key);
			this.protocolManager.onConnectionClosed(conn);
			log(`connection to ${key} closed (total: ${this.connections.size})`);
		});

		return conn;
	}

	// ---------- jittered background loops ----------

	private withJitter(baseMs: number, jitterFraction = 0.2) {
		const delta = baseMs * jitterFraction;
		return baseMs + (Math.random() * 2 - 1) * delta;
	}

	private runAdvertLoop() {
		const loop = async () => {
			try {
				await this.broadcastAdvert();
			} catch (e) {
				log(`advert loop error: ${String(e)}`);
			}
			setTimeout(loop, this.withJitter(10_000));
		};
		setTimeout(loop, this.withJitter(10_000));
	}

	private runDiscoveryLoop() {
		const loop = async () => {
			try {
				await this.discoverPeers();
			} catch (e) {
				log(`discovery loop error: ${String(e)}`);
			}
			setTimeout(loop, this.withJitter(15_000));
		};
		setTimeout(loop, this.withJitter(15_000));
	}

	private runContactLoop() {
		const loop = async () => {
			try {
				await this.connectToAdvertisedPeers();
			} catch (e) {
				log(`contact loop error: ${String(e)}`);
			}
			setTimeout(loop, this.withJitter(20_000));
		};
		setTimeout(loop, this.withJitter(20_000));
	}
}
