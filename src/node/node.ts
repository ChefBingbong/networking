import type { Stream } from "@libp2p/interface-connection";
import debug from "debug";
import { EventEmitter } from "events";
import {
	DEFAULT_RENDEZVOUS_CONFIG,
	Rendezvous,
} from "../discovery/rendevous/rendevous";
import type { SignedAdvert } from "../discovery/rendevous/types";
import { decodeFrames, encodeFrame, wait } from "../packet/encode";
import { mkBroadcastAdvert } from "../packet/packets";
import type { Packet } from "../packet/types";
import {
	generateSecp256k1KeyPrivPubPair,
	type PeerKeyPair,
} from "../secp256k1/utils";
import type { PeerInfo, PeerRemote } from "../session/nodeInfo";
import { safeError, safeResult } from "../utils/safe";
import type { Connection } from "./connection";
import type { NetworkEventEmitter } from "./events";
import type { TransportListener } from "./transport";
import { Transport } from "./transport/transport";
import { NodeUpgrader } from "./upgrader";

const log = debug("p2p:node");

type KnownPeer = {
	id: string;
	host: string;
	port: number;
	lastSeen: number; // epoch seconds
	expiresAt?: number; // epoch seconds
	online: boolean;
};

export class PeerNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: PeerInfo;
	private transport: Transport;
	private rendezvous: Rendezvous;
	public connections: Map<string, Connection> = new Map();
	private keyPair: PeerKeyPair;
	public peers: Map<string, PeerRemote> = new Map(); // minimal addr book
	public advert: SignedAdvert;
	public adverts: Map<string, SignedAdvert> = new Map();

	// local caches
	public listener: TransportListener;
	private knownPeers: Map<string, KnownPeer> = new Map();
	private discoveredSent: Set<string> = new Set(); // peers we've already advertised to (recently)

	constructor(nodeInfo: PeerInfo) {
		super();
		this.info = nodeInfo;
		this.keyPair = generateSecp256k1KeyPrivPubPair();

		const upgrader = new NodeUpgrader(
			this.keyPair.privateKey,
			debug("p2p:upgrader"),
		);

		this.transport = new Transport(this.keyPair, upgrader);
		this.rendezvous = new Rendezvous(DEFAULT_RENDEZVOUS_CONFIG, this.info);
		this.advert = this.rendezvous.createAdvert();

		// Listener now gets fully-upgraded Connections, not frames
		this.listener = this.transport.createListener(
			this.info,
			this.onIncomingConnection,
		);
	}

	public async start() {
		const listenError = await this.listener.listen(this.info);
		if (listenError) {
			log("Failed to start listener:", listenError);
			return;
		}
		log(`🚀 Node started at ${this.info.host}:${this.info.port}`);

		// Start periodic advertisement + discovery loops
		this.runAdvertLoop();
		this.runDiscoveryLoop();
	}

	// --- Periodic Advert Loop ---
	private async runAdvertLoop() {
		while (true) {
			try {
				await this.broadcastAdvert();
			} catch (e) {
				log("advert loop error:", e);
			}
			await wait(15_000); // every 15s
		}
	}

	// --- Periodic Discovery Loop ---
	private async runDiscoveryLoop() {
		while (true) {
			try {
				await this.discoverPeers();
			} catch (e) {
				log("discover loop error:", e);
			}
			await wait(20_000); // every 20s
		}
	}

	// helper: is advert still valid (using advert.expires_at seconds)
	private isAdvertValid(ad: SignedAdvert | undefined) {
		if (!ad || !ad.advert?.expires_at) return false;
		const now = Date.now() / 1000;
		return now < ad.advert.expires_at;
	}

	// helper: mark peer as known/online
	private markPeerOnline(
		nodeId: string,
		host: string,
		port: number,
		expiresAt?: number,
	) {
		const now = Date.now() / 1000;
		const existing = this.knownPeers.get(nodeId);
		const kp: KnownPeer = {
			id: nodeId,
			host,
			port,
			lastSeen: now,
			expiresAt,
			online: true,
		};
		// merge
		if (existing) {
			kp.expiresAt = existing.expiresAt ?? expiresAt;
		}
		this.knownPeers.set(nodeId, kp);
		// also keep minimal peers map for dialing
		this.peers.set(nodeId, { id: nodeId, host, port });
	}

	// --- NEW: generic packet sender over a stream ---
	private async sendPacket(
		conn: Connection,
		packet: Packet,
		protocol = "/p2p/main/1.0.0",
	) {
		const stream = await this.transport.upgrader.createStream(conn, [protocol]);
		const encoded = encodeFrame(packet);

		await stream.sink(
			(async function* () {
				yield encoded;
			})(),
		);

		// // one-shot stream, close it
		// if (typeof (stream as any)?.close === "function") {
		// 	await (stream as any)?.close?.();
		// }
	}

	// --- NEW: handle incoming streams & decode frames ---
	private async handleStream(conn: Connection, stream: Stream) {
		let partial = Buffer.alloc(0);

		try {
			for await (const chunk of stream.source) {
				const buf =
					chunk instanceof Uint8Array
						? Buffer.from(chunk)
						: Buffer.from(
								// Uint8ArrayList or other types
								(chunk as any).subarray
									? (chunk as any).subarray()
									: new Uint8Array(chunk as any),
							);

				partial = Buffer.concat([partial, buf]);
				partial = decodeFrames(partial, (pkt: Packet) => {
					// fire-and-forget per-packet handler
					this.onPacket(conn, pkt).catch((e) => log("onPacket error:", e));
				});
			}
		} catch (e) {
			log("handleStream error:", e);
		}
	}

	// --- NEW: when a fully-upgraded connection arrives from the listener ---
	private onIncomingConnection = async (conn: Connection) => {
		// If the upgrader sets conn.remotePeer, you can use it as an id
		const remoteId =
			(conn.remotePeer as any)?.toString?.() ?? conn.remoteAddr.toString();

		this.connections.set(remoteId, conn);

		// if your MuxedConnection emits "stream:open" events, hook them:
		const anyConn = conn as any;
		if (typeof anyConn.on === "function") {
			anyConn.on("stream:open", (stream: Stream) => {
				this.handleStream(conn, stream).catch((e) =>
					log("handleStream error:", e),
				);
			});

			anyConn.once("close", () => {
				const kp = this.knownPeers.get(remoteId);
				if (kp) {
					kp.online = false;
					this.knownPeers.set(remoteId, kp);
				}
				this.connections.delete(remoteId);
				log(`🧹 Disconnected from ${remoteId}`);
			});
		}
	};

	// Broadcast own advert to known or candidate peers, skipping already-advertised & valid peers
	private async broadcastAdvert() {
		const packet = mkBroadcastAdvert(JSON.stringify(this.advert));

		// choose candidate list: known peers first; otherwise rendezvous candidates
		let peerList = Array.from(this.peers.values());
		if (peerList.length === 0) {
			peerList = this.rendezvous.deriveCandidateAddresses(4000, 10);
		}

		for (const peer of peerList) {
			// skip self
			if (peer.port === this.info.port && peer.host === this.info.host)
				continue;

			// skip if we've already sent advert to this peer recently AND that peer is online & advert still valid
			const kp = this.knownPeers.get(peer.id);
			if (
				kp &&
				kp.online &&
				kp.expiresAt &&
				Date.now() / 1000 < kp.expiresAt &&
				this.discoveredSent.has(peer.id)
			) {
				continue;
			}

			const [err, conn] = await this.transport.dial(
				this.info,
				peer,
				5000,
				true, // encrypt+upgrade
			);
			if (err || !conn) {
				// failed dial: mark offline if we had them known
				if (peer.id && this.knownPeers.has(peer.id)) {
					const ex = this.knownPeers.get(peer.id)!;
					ex.online = false;
					this.knownPeers.set(peer.id, ex);
				}
				continue;
			}

			// success: update known state & mark we sent them advert
			try {
				this.markPeerOnline(
					peer.id,
					peer.host,
					peer.port,
					this.advert.advert.expires_at,
				);
			} catch {}

			this.discoveredSent.add(peer.id);

			// send advert over a single-use stream
			await this.sendPacket(conn, packet, "/p2p/advert/1.0.0");

			// ephemeral advert connection – close it
			await conn.close().catch(() => {});
		}

		log(`📢 Advert broadcasted from ${this.info.id}`);
	}

	// Handle received adverts
	private async handleIncomingAdvert(signed: SignedAdvert) {
		if (!signed?.advert?.addr || !signed?.advert?.node_id) return;
		const nodeId = signed.advert.node_id;
		if (nodeId === this.info.id) return;

		const [host, portStr] = signed.advert.addr.split(":");
		const port = Number(portStr);
		if (!host || !port) return;

		// store advert and mark the peer
		this.peers.set(nodeId, { id: nodeId, host, port });
		this.adverts.set(nodeId, signed);

		// store known peer with expiry
		const expiresAt = signed.advert.expires_at;
		this.markPeerOnline(nodeId, host, port, expiresAt);

		log(`🗂 Stored advert from ${nodeId} (${host}:${port})`);
	}

	// Discover peers and gossip peer lists
	public async discoverPeers(maxConnections = 5) {
		// prune stale discoveredSent entries for expired peers
		for (const id of Array.from(this.discoveredSent)) {
			const kp = this.knownPeers.get(id);
			if (!kp) {
				this.discoveredSent.delete(id);
				continue;
			}
			if (kp.expiresAt && Date.now() / 1000 >= kp.expiresAt) {
				// expired
				this.discoveredSent.delete(id);
			}
		}

		const candidates: PeerRemote[] = [];

		for (const adv of this.adverts.values()) {
			const [host, portStr] = adv.advert.addr.split(":");
			const port = Number(portStr);
			if (!host || !port) continue;
			if (adv.advert.node_id === this.info.id) continue;
			if (this.connections.has(adv.advert.node_id)) continue;

			// if we already sent them an advert and are online and advert still valid, skip
			const kp = this.knownPeers.get(adv.advert.node_id);
			if (
				kp &&
				kp.online &&
				kp.expiresAt &&
				Date.now() / 1000 < kp.expiresAt &&
				this.discoveredSent.has(adv.advert.node_id)
			) {
				continue;
			}

			candidates.push({ id: adv.advert.node_id, host, port });
		}

		const selected = candidates.slice(0, maxConnections);
		for (const peer of selected) {
			// avoid duplicate connection attempts
			if (this.connections.has(peer.id)) continue;

			const [err, conn] = await this.transport.dial(this.info, peer);
			if (err || !conn) {
				log(`❌ Failed to dial peer ${peer.id}: ${err?.message}`);
				// mark offline in knownPeers if present
				const kp = this.knownPeers.get(peer.id);
				if (kp) {
					kp.online = false;
					this.knownPeers.set(peer.id, kp);
				}
				continue;
			}

			// Successfully connected -> mark online and update lastSeen
			this.markPeerOnline(
				peer.id,
				peer.host,
				peer.port,
				this.adverts.get(peer.id)?.advert?.expires_at,
			);

			this.connections.set(peer.id, conn);

			// hook stream events / close event
			await this.onIncomingConnection(conn);

			// Upon connection, exchange peer lists over a stream
			await this.sendPacket(
				conn,
				{
					t: "PEER_LIST",
					from: this.info.id,
					payload: { peers: Array.from(this.peers.values()) },
				} as Packet,
				"/p2p/peer-list/1.0.0",
			);

			log(`✅ Connected to peer ${peer.id} (${peer.host}:${peer.port})`);
		}
	}

	public async ensureConn(id: string) {
		const connection = this.connections.get(id);
		if (connection) return safeResult(connection);

		const peerId = this.peers.get(id);
		if (!peerId) return safeResult(undefined);

		const [error, conn] = await this.transport.dial(this.info, peerId);
		if (error || !conn) return safeError(error ?? new Error("no connection"));

		this.connections.set(id, conn);
		await this.onIncomingConnection(conn);

		return safeResult(conn);
	}

	// --- Core packet handler (now packets come from streams) ---
	private onPacket = async (conn: Connection, f: Packet) => {
		if (f.t === "PING") {
			log(`[${this.info.id}] <- PING from ${f.payload?.id}`);

			const srcId = f.payload?.id;
			if (srcId && !this.connections.has(srcId)) {
				this.connections.set(srcId, conn);
			}

			await this.sendPacket(
				conn,
				{ t: "PONG", payload: { id: this.info.id } } as Packet,
				"/p2p/ping/1.0.0",
			);
		} else if (f.t === "PONG") {
			console.log(`[${this.info.id}] <${f.from}>: ${f.payload?.text}`);
		} else if (f.t === "BROADCAST_ADVERT" || f.t === "DISCOVERY_RESPONSE") {
			try {
				const signed: SignedAdvert = JSON.parse(f.payload.advert);
				await this.handleIncomingAdvert(signed);
			} catch (err) {
				log("Failed to parse advert:", err);
			}
		} else if (f.t === "PEER_LIST") {
			const incoming = f.payload.peers as PeerRemote[];
			const newlyLearned: PeerRemote[] = [];
			for (const p of incoming) {
				if (p.id === this.info.id) continue;
				if (!this.peers.has(p.id)) {
					this.peers.set(p.id, p);
					newlyLearned.push(p);
					log(`🌐 Learned new peer ${p.id} from gossip`);
				}
			}
			// try connect to them lazily (non-blocking)
			if (newlyLearned.length > 0) {
				for (const p of newlyLearned) {
					// avoid duplicates
					if (!this.connections.has(p.id)) {
						// schedule ensureConn but don't await them all here
						this.ensureConn(p.id).catch((e) => log("ensureConn error:", e));
					}
				}
			}
		}
	};
}
