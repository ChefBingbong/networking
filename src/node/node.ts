import debug from "debug";
import { EventEmitter } from "events";
import {
	DEFAULT_RENDEZVOUS_CONFIG,
	Rendezvous,
} from "../discovery/rendevous/rendevous";
import type { SignedAdvert } from "../discovery/rendevous/types";
import { wait } from "../packet/encode";
import { mkBroadcastAdvert } from "../packet/packets";
import type { Packet } from "../packet/types";
import {
	generateSecp256k1KeyPrivPubPair,
	type PeerKeyPair,
} from "../secp256k1/utils";
import type { PeerInfo, PeerRemote } from "../session/nodeInfo";
import { safeError, safeResult } from "../utils/safe";
import type { MuxedConnection } from "./connection";
import type { TransportListener } from "./transport";
import { Transport } from "./transport/transport";

const log = debug("p2p:node");

interface KnownPeer {
	id: string;
	host: string;
	port: number;
	lastSeen: number;
	expiresAt?: number;
	online: boolean;
}

export class PeerNode extends EventEmitter {
	public info: PeerInfo;
	private keyPair: PeerKeyPair;
	private transport: Transport;
	private rendezvous: Rendezvous;

	private connections: Map<string, MuxedConnection> = new Map();
	private peers: Map<string, PeerRemote> = new Map();
	private adverts: Map<string, SignedAdvert> = new Map();
	private knownPeers: Map<string, KnownPeer> = new Map();

	private sentAdverts: Set<string> = new Set();

	private listener: TransportListener;
	private advert: SignedAdvert;

	constructor(nodeInfo: PeerInfo) {
		super();
		this.info = nodeInfo;
		this.keyPair = generateSecp256k1KeyPrivPubPair();
		this.transport = new Transport(this.keyPair);
		this.rendezvous = new Rendezvous(DEFAULT_RENDEZVOUS_CONFIG, this.info);
		this.advert = this.rendezvous.createAdvert();
		this.listener = this.transport.createListener(this.info, this.onFrame);
	}

	// --- Startup ---
	public async start() {
		const listenError = await this.listener.listen(this.info);
		if (listenError) {
			log("Failed to start listener:", listenError);
			return;
		}

		log(`🚀 Peer started at ${this.info.host}:${this.info.port}`);
		this.runAdvertLoop();
		this.runDiscoveryLoop();
	}

	// --- Periodic Advert Loop ---
	private async runAdvertLoop() {
		while (true) {
			try {
				await this.broadcastAdvert();
			} catch (err) {
				log("Advert loop error:", err);
			}
			await wait(15_000);
		}
	}

	// --- Periodic Discovery Loop ---
	private async runDiscoveryLoop() {
		while (true) {
			try {
				await this.discoverPeers();
			} catch (err) {
				log("Discovery loop error:", err);
			}
			await wait(20_000);
		}
	}

	// --- Advert Broadcasting ---
	private async broadcastAdvert() {
		const advertPacket = mkBroadcastAdvert(JSON.stringify(this.advert));

		let candidatePeers = Array.from(this.peers.values());
		if (candidatePeers.length === 0) {
			candidatePeers = this.rendezvous.deriveCandidateAddresses(4000, 15);
		}

		for (const peer of candidatePeers) {
			if (peer.host === this.info.host && peer.port === this.info.port)
				continue;

			const knownPeer = this.knownPeers.get(peer.id);
			if (
				knownPeer?.online &&
				knownPeer.expiresAt &&
				Date.now() / 1000 < knownPeer.expiresAt &&
				this.sentAdverts.has(peer.id)
			) {
				continue;
			}

			const [error, conn] = await this.transport.dial(
				this.info,
				peer,
				5000,
				true,
			);
			if (error) {
				this.markPeerOffline(peer.id);
				continue;
			}

			this.markPeerOnline(
				peer.id,
				peer.host,
				peer.port,
				this.advert.advert.expires_at,
			);
			this.sentAdverts.add(peer.id);
			conn.send(advertPacket);

			conn.once("close", () => this.connections.delete(peer.id));
			log(`📢 Advert sent to ${peer.id}`);
		}
	}

	// --- Discovery Logic ---
	private async discoverPeers(maxNewConnections = 5) {
		this.cleanupExpiredPeers();

		const candidates: PeerRemote[] = [];
		for (const advert of this.adverts.values()) {
			const nodeId = advert.advert.node_id;
			if (nodeId === this.info.id) continue;
			if (this.connections.has(nodeId)) continue;

			const [host, portStr] = advert.advert.addr.split(":");
			const port = Number(portStr);
			if (!host || !port) continue;

			const knownPeer = this.knownPeers.get(nodeId);
			const isRecent =
				knownPeer?.online &&
				knownPeer.expiresAt &&
				Date.now() / 1000 < knownPeer.expiresAt;
			if (isRecent && this.sentAdverts.has(nodeId)) continue;

			candidates.push({ id: nodeId, host, port });
		}

		for (const peer of candidates.slice(0, maxNewConnections)) {
			const [error, conn] = await this.transport.dial(this.info, peer);
			if (error) {
				this.markPeerOffline(peer.id);
				continue;
			}

			this.markPeerOnline(peer.id, peer.host, peer.port);
			this.connections.set(peer.id, conn);

			conn.on("frame", (frame: Packet) => this.onFrame(conn, frame));
			conn.once("close", () => this.markPeerOffline(peer.id));

			conn.send({
				t: "PEER_LIST",
				from: this.info.id,
				payload: { peers: Array.from(this.peers.values()) },
			});

			log(`✅ Connected to ${peer.id} (${peer.host}:${peer.port})`);
		}
	}

	// --- Packet Handler ---
	private onFrame = async (conn: MuxedConnection, frame: Packet) => {
		switch (frame.t) {
			case "PING":
				conn.send({ t: "PONG", payload: { id: this.info.id } });
				break;

			case "MSG":
				log(`[${this.info.id}] <${frame.from}>: ${frame.payload?.text}`);
				break;

			case "BROADCAST_ADVERT":
			case "DISCOVERY_RESPONSE":
				try {
					const signed: SignedAdvert = JSON.parse(frame.payload.advert);
					await this.handleIncomingAdvert(signed);
				} catch (err) {
					log("Failed to parse advert:", err);
				}
				break;

			case "PEER_LIST": {
				const peers = frame.payload.peers as PeerRemote[];
				this.integratePeerList(peers);
				break;
			}
		}
	};

	// --- Handle Incoming Adverts ---
	private async handleIncomingAdvert(advert: SignedAdvert) {
		const nodeId = advert?.advert?.node_id;
		const addr = advert?.advert?.addr;
		if (!nodeId || !addr || nodeId === this.info.id) return;

		const [host, portStr] = addr.split(":");
		const port = Number(portStr);
		if (!host || !port) return;

		this.peers.set(nodeId, { id: nodeId, host, port });
		this.adverts.set(nodeId, advert);
		this.markPeerOnline(nodeId, host, port, advert.advert.expires_at);

		log(`🗂 Stored advert from ${nodeId} (${host}:${port})`);
	}

	// --- Peer List Integration ---
	private integratePeerList(peers: PeerRemote[]) {
		for (const peer of peers) {
			if (peer.id === this.info.id) continue;
			if (!this.peers.has(peer.id)) {
				this.peers.set(peer.id, peer);
				log(`🌐 Discovered new peer ${peer.id}`);
				this.ensureConnection(peer.id).catch((e) =>
					log("ensureConnection error:", e),
				);
			}
		}
	}

	// --- Connection Ensure ---
	private async ensureConnection(peerId: string) {
		if (this.connections.has(peerId))
			return safeResult(this.connections.get(peerId));
		const peer = this.peers.get(peerId);
		if (!peer) return safeResult(undefined);

		const [error, conn] = await this.transport.dial(this.info, peer);
		if (error) return safeError(error);

		this.connections.set(peerId, conn);
		conn.on("frame", (frame: Packet) => this.onFrame(conn, frame));
		conn.once("close", () => this.markPeerOffline(peerId));

		return safeResult(conn);
	}

	// --- Helpers ---
	private markPeerOnline(
		id: string,
		host: string,
		port: number,
		expiresAt?: number,
	) {
		const now = Date.now() / 1000;
		this.knownPeers.set(id, {
			id,
			host,
			port,
			lastSeen: now,
			expiresAt,
			online: true,
		});
		this.peers.set(id, { id, host, port });
	}

	private markPeerOffline(id: string) {
		const known = this.knownPeers.get(id);
		if (known) {
			known.online = false;
			this.knownPeers.set(id, known);
		}
	}

	private cleanupExpiredPeers() {
		const now = Date.now() / 1000;
		for (const [id, peer] of this.knownPeers.entries()) {
			if (peer.expiresAt && peer.expiresAt < now) {
				this.sentAdverts.delete(id);
				this.knownPeers.delete(id);
				this.peers.delete(id);
			}
		}
	}
}
