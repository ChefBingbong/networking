// src/node/node.ts
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import { EventEmitter } from "events";
import type { MuxedConnection } from "../connection/connection";
import type { ProtocolHandler } from "../connection/protocol-manager";
import { ProtocolManager } from "../connection/protocol-manager";
import { pk2id } from "../devp2p";
import { createKadApi } from "../http/api";
import { KademliaNode as KademliaDHT, KademliaNode, type KademliaNodeConfig } from "../kademlia/kademlia";
import type { PeerInfo as KadPeerInfo } from "../kademlia/types";
import { hashToId } from "../kademlia/xor";
import type { Packet } from "../packet/types";
import type { PeerInfo } from "../session/nodeInfo";
import { safeError, safeResult } from "../utils/safe";
import { getHostPortFromMultiaddr } from "../utils/utils";
import { CoreMessageHandler } from "./core-handler";
import { BOOTSTRAP_ADDRS } from "./createNode"; // Multiaddr[]
import type { TransportListener } from "./transport";
import { MessageRouter } from "./transport/message-router";
import { Transport } from "./transport/transport";
import type { NodeMetrics, NodeMetricsSnapshot } from "./types";
// import type { BlockchainClientState } from "../blockchain/client/client";
import { secp256k1 } from 'ethereum-cryptography/secp256k1.js';
import { bytesToHex } from "ethereum-cryptography/utils";

const log = debug("p2p:node");

const DIAL_BACKOFF_MS = 5_000;

export class PeerNode extends EventEmitter {
	public metrics: NodeMetrics = {
		firstConnectLatencies: new Map(),
		pingLatencies: [],
	};

	private transport: Transport;
	public connections = new Map<string, MuxedConnection>();

	public peerId: Uint8Array<ArrayBufferLike>;
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


		this.protocolManager = new ProtocolManager();
		this.coreHandler = new CoreMessageHandler(this);

		// Create Kademlia node with options
		const kadOptions: KademliaNodeConfig = {
			k: 16,
			timeout: 4000,
			endpoint: {
				address: nodeOptions.host,
				udpPort: nodeOptions.port,
				tcpPort: nodeOptions.port,
			},
			refreshInterval: 60000,
			shouldFindNeighbours: true,
			onlyConfirmed: false,
		  }
	  
		  this.kad = new KademliaNode(nodeOptions.privateKey.raw, kadOptions)
		  this.peerId = this.kad.id
	  
		  this.address = multiaddr(
			`/ip4/${nodeOptions.host}/tcp/${nodeOptions.port}/p2p/${bytesToHex(this.peerId)}`,
		);


		this.router = new MessageRouter();
		this.router.register(this.protocolManager.handle);
		this.router.register(this.coreHandler.handle);

		this.listener = this.transport.createListener({
			frameHandler: this.router.handle,
			streamOpenHandler: (protocol, stream) =>
				this.protocolManager.onIncomingStream(protocol, stream),
		});
	}

	public async start() {
		try {
			log(
				`starting node ${this.peerId.toString()} at ${this.address.toString()}`,
			);
			createKadApi(this, 4000 + this.nodeOptions.port);
			await this.startListening();
			// Bind UDP transport for discovery
			this.kad.transport.bind(this.nodeOptions.port, this.nodeOptions.host);
			await this.kadBootstrap();
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
		return this.kad.getPeers().map((peer) => {
			if (peer.address && peer.tcpPort !== null) {
				return `/ip4/${peer.address}/tcp/${peer.tcpPort}`;
			}
			return "";
		}).filter((addr) => addr !== "");
	}

	public async kadBootstrap() {
		// Seed from static bootstrap addresses
		const bootstrapPeers: KadPeerInfo[] = BOOTSTRAP_ADDRS.map((pk) => {
			const peerId = pk2id(secp256k1.getPublicKey(pk, false))
			const peer: KadPeerInfo = {
				address: "127.0.0.1",
				udpPort: 4000,
				tcpPort: 4000,
				id: peerId,
			};
			return peer;
		}).filter((p) => p.address !== undefined && (p.udpPort !== null || p.tcpPort !== null));

		// Bootstrap with each peer sequentially
		for (const peer of bootstrapPeers) {
			try {
				await this.kad.bootstrap(peer);
			} catch (err) {
				log(`Failed to bootstrap with ${peer.address}:${peer.udpPort}: ${err}`);
			}
		}
	}

	/**
	 * Periodic Kademlia maintenance is now handled internally by KademliaNode
	 * via refreshInterval. The refresh() method is called automatically.
	 */
	private runContactLoop() {
		// Kademlia refresh is now handled automatically by the node's refresh interval
		// No additional loops needed
	}

	public async connectToKadPeers() {
		// Optionally: dial TCP to DHT-known peers
		const kadPeers = this.kad.getPeers();
		for (const peer of kadPeers) {
			try {
				if (peer.address && peer.tcpPort !== null) {
					const addr = multiaddr(`/ip4/${peer.address}/tcp/${peer.tcpPort}`);
					if (peer.id) {
						const peerIdHex = Array.from(peer.id)
							.map((b) => b.toString(16).padStart(2, "0"))
							.join("");
						const fullAddr = multiaddr(`${addr.toString()}/p2p/${peerIdHex}`);
						await this.dial(fullAddr.toString());
					} else {
						await this.dial(addr.toString());
					}
				}
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
		const key = addr.toString().split("/p2p/")[0]!;
		this.connections.set(key, conn);
		log(`connection established to ${key} (total: ${this.connections.size})`);

		// Feed this TCP-connected peer into Kademlia as a contact
		const remotePeerId = this.extractPeerIdFromMultiaddr(addr);
		if (remotePeerId) {
			const { host, port } = getHostPortFromMultiaddr(addr);
			const kadPeer: KadPeerInfo = {
				id: hashToId(remotePeerId),
				address: host,
				udpPort: port,
				tcpPort: port,
			};
			this.kad
				.addPeer(kadPeer)
				.catch((err) => {
					log(
						`failed to add kad peer for ${key}: ${
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
