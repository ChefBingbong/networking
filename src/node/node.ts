import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import { EventEmitter } from "events";
import type { MuxedConnection } from "../connection/connection";
import type { ProtocolHandler } from "../connection/protocol-manager";
import { ProtocolManager } from "../connection/protocol-manager";
import { createKadApi } from "../http/api";
import type { KadRoutingTableDump } from "../kademlia/kademlia";
import { KademliaDHT } from "../kademlia/kademlia";
import type { Packet } from "../packet/types";
import { loopInterval } from "../secp256k1/utils";
import type { PeerId, PeerInfo } from "../session/nodeInfo";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { safeError, safeResult } from "../utils/safe";
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

		this.kad = new KademliaDHT(this, {
			k: 16,
			alpha: 3,
			maxBuckets: 256,
		});

		this.router = new MessageRouter();
		this.router.register(this.protocolManager.handle);
		this.router.register(this.coreHandler.handle);

		this.listener = this.transport.createListener({
			frameHandler: this.router.handle,
			streamOpenHandler: (protocol, stream) =>
				this.protocolManager.onIncomingStream(protocol, stream),
		});

		createKadApi(this, 4001 + nodeOptions.port);
	}

	public async start() {
		try {
			log(
				`starting node ${this.peerId.toString()} at ${this.address.toString()}`,
			);
			await this.startListening();
			await this.kadBootstrap();
			this.runContactLoop();
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

	public getKadRoutingTable(): KadRoutingTableDump {
		return this.kad.dumpRoutingTable();
	}

	public getKadPeers() {
		return this.kad.getKnownKadPeers();
	}

	public async kadBootstrap() {
		this.kad.addBootstrapPeers(BOOTSTRAP_ADDRS);
		await this.kad.bootstrapLookup();
	}

	private runContactLoop() {
		loopInterval(async () => {
			await this.kad.bootstrapLookup();
			await this.kad.randomNodeLookup(20);

			await this.kad.pingRandomPeers(20);
			this.kad.pruneStalePeers(30_000); // e.g. 2 minutes
		}, this.withJitter(10_000));
	}

	public async connectToKadPeers() {
		const kadPeers = this.kad.getKnownKadPeers();
		for (const p of kadPeers) {
			if (p.id === this.peerId.toString()) continue;

			try {
				await this.dial(p.addr);
			} catch {}
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

		this.kad.noteConnectedPeer(addr);

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

	private withJitter(baseMs: number, jitterFraction = 0.2) {
		const delta = baseMs * jitterFraction;
		return baseMs + (Math.random() * 2 - 1) * delta;
	}
}
