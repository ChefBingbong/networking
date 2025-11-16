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
import { loopInterval } from "../secp256k1/utils";
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

	private failedPeers = new Map<string, number>(); // addrKey -> nextAllowedDialTs

	constructor(nodeOptions: PeerInfo) {
		super();
		this.nodeOptions = nodeOptions;
		this.transport = new Transport(nodeOptions.privateKey, {
			maxActiveDials: 16,
		});
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

		this.listener = this.transport.createListener({
			frameHandler: this.router.handle,
			streamOpenHandler: (protocol, stream) =>
				this.protocolManager.onIncomingStream(protocol, stream),
		});
	}

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

	public async broadcastAdvert() {
		this.rendezvous.refreshAdvertIfNeeded();
		const advert = this.rendezvous.getCurrentAdvert();

		const targets = this.rendezvous
			.getAdvertBroadcastTargets()
			.filter(this.filterKnownAndSelfAddrs);

		targets.forEach(async (addr) => {
			try {
				const conn = await this.getExistingOrNewConnection(addr, false);
				conn.send(mkBroadcastAdvert(JSON.stringify(advert)));
				log(`📢 Advert sent to ${addr.toString()}`);
			} catch {}
		});
	}

	public async discoverPeers(maxNewConnections = 50) {
		const degree = this.connections.size;
		const remainingBudget = Math.max(0, DEGREE_MAX - degree);

		if (remainingBudget === 0 || degree >= DEGREE_MIN) return;

		this.rendezvous.refreshAdvertIfNeeded();
		const slots = this.rendezvous.getDiscoverySlots();

		const targets = this.rendezvous
			.getDiscoveryTargets(Math.min(maxNewConnections, remainingBudget))
			.filter(this.filterKnownAndSelfAddrs);

		targets.forEach(async (addr) => {
			try {
				const conn = await this.getExistingOrNewConnection(addr, false);
				conn.send(mkDiscoveryRequest(slots, this.address.toString()));
				log(`Sent DISCOVERY_REQUEST to ${addr.toString()}`);
			} catch {}
		});
	}

	public async connectToAdvertisedPeers() {
		const degree = this.connections.size;
		const remainingBudget = Math.max(0, DEGREE_MAX - degree);
		if (remainingBudget === 0 || degree >= DEGREE_MIN) return;

		const allAdverts = this.rendezvous.getKnownAdvertPeers();
		const candidates = allAdverts.filter(this.filterKnownAndSelfAddrs);

		for (const addr of candidates.slice(0, remainingBudget)) {
			try {
				const conn = await this.getExistingOrNewConnection(addr, true, 5_000);
				conn.send(mkPing(this.address.toString()));
				log(`Connected to ${addr.toString()} (from adverts)`);
			} catch {}
		}
	}

	private async getExistingOrNewConnection(
		mAddr: Multiaddr,
		storeConnection = true,
		timeoutMs = 10_000,
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
		});

		return conn;
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

	private filterKnownAndSelfAddrs = (addr: Multiaddr) => {
		const key = addr.toString();
		if (key === this.address.toString()) return false;
		if (this.connections.has(key)) return false;
		return true;
	};

	private withJitter(baseMs: number, jitterFraction = 0.2) {
		const delta = baseMs * jitterFraction;
		return baseMs + (Math.random() * 2 - 1) * delta;
	}

	private startListening() {
		return this.listener.listen(this.address);
	}

	private runAdvertLoop() {
		loopInterval(
			async () => await this.broadcastAdvert(),
			this.withJitter(10_000),
		);
	}

	private runDiscoveryLoop() {
		loopInterval(
			async () => await this.discoverPeers(),
			this.withJitter(15_000),
		);
	}

	private runContactLoop() {
		loopInterval(
			async () => await this.connectToAdvertisedPeers(),
			this.withJitter(20_000),
		);
	}
}
