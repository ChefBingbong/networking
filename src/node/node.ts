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
import { ProtocolManager } from "../protocol/protocol-manager";
import type { ProtocolHandler } from "../protocol/protocol-stream";
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

type NodeMetrics = {
	// first successful connect latency per peer (ms)
	firstConnectLatencies: Map<string, number>;
	// ping RTTs in ms (filled by CoreMessageHandler)
	pingLatencies: number[];
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
		// assuming your CoreMessageHandler signature is (address: Multiaddr, node: PeerNode)
		this.coreHandler = new CoreMessageHandler(this);

		this.router = new MessageRouter();
		this.router.register(this.protocolManager.handle);
		this.router.register(this.rendezvous.handle);
		this.router.register(this.coreHandler.handle);

		this.listener = this.transport.createListener(this.router.handle);
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
			const conn = await this.getExistingOrNewConnection(mAddr);
			return safeResult(conn);
		} catch (error) {
			return safeError(error);
		}
	}

	public async dialProtocol(addr: Multiaddr, protocol: string) {
		try {
			const connection = await this.getExistingOrNewConnection(addr);
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

	private hasReachedSaturation() {
		return this.getCurrentDegree() >= DEGREE_MIN;
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
				const conn = await this.getExistingOrNewConnection(addr, false);
				conn.send(mkBroadcastAdvert(JSON.stringify(advert)));
				log(`📢 Advert sent to ${addr.toString()}`);
			} catch {
				// ignore individual target errors
			}
		});
	}

	/**
	 * Discovery:
	 * - Only runs when degree < DEGREE_MIN (below target band).
	 * - Caps new dials so we don't overshoot far past DEGREE_MAX.
	 */
	public async discoverPeers(maxNewConnections = 25) {
		const degree = this.getCurrentDegree();
		if (degree >= DEGREE_MIN) {
			// already within / above our target band; skip active discovery
			return;
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
				const conn = await this.getExistingOrNewConnection(addr, false);
				conn.send(mkDiscoveryRequest(slots, this.address.toString()));
				log(`Sent DISCOVERY_REQUEST to ${addr.toString()}`);
			} catch {
				// ignore
			}
		});
	}

	/**
	 * Connect to peers we learned via adverts.
	 * Same degree band logic as discoverPeers.
	 */
	public async connectToAdvertisedPeers(maxNewConnections = 25) {
		const degree = this.getCurrentDegree();
		if (degree >= DEGREE_MIN) {
			// good enough, don't aggressively hunt for more
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
				const conn = await this.getExistingOrNewConnection(addr);
				// basic keepalive / health check
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
	) {
		const key = mAddr.toString();
		const existing = this.connections.get(key);
		if (existing) return existing;

		const start = Date.now();
		const [error, dialedConn] = await this.transport.dial(mAddr);
		const elapsed = Date.now() - start;

		if (error) throw error;

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

		// route non-stream frames to router (Core/Rendezvous/etc)
		conn.setOnFrame((frame: Packet) => {
			this.router.handle(conn, frame);
		});

		// NEW: route incoming streams into ProtocolManager
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

	// ---------- background loops ----------

	private runAdvertLoop() {
		loopInterval(async () => {
			// adverts should still be gossiped even if we're already saturated,
			// so other nodes can discover us.
			await this.broadcastAdvert();
		}, 10_000);
	}

	private runDiscoveryLoop() {
		loopInterval(async () => {
			await this.discoverPeers();
		}, 15_000);
	}

	private runContactLoop() {
		loopInterval(async () => {
			await this.connectToAdvertisedPeers();
		}, 20_000);
	}
}
