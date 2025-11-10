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
import type { NetworkEventEmitter } from "./events";
import type { TransportListener } from "./transport";
import { Transport } from "./transport/transport";

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
	public connections: Map<string, MuxedConnection> = new Map();
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
		this.transport = new Transport(this.keyPair);
		this.rendezvous = new Rendezvous(DEFAULT_RENDEZVOUS_CONFIG, this.info);
		this.advert = this.rendezvous.createAdvert();
		this.listener = this.transport.createListener(this.info, this.onFrame);
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

	// Broadcast own advert to known or candidate peers, skipping already-advertised & valid peers
	private async broadcastAdvert() {
		const packet = mkBroadcastAdvert(JSON.stringify(this.advert));

		// choose candidate list: known peers first; otherwise rendezvous candidates
		let peerList = Array.from(this.peers.values());
		if (peerList.length === 0) {
			peerList = this.rendezvous.deriveCandidateAddresses(4000, 50);
		}

		for (const peer of peerList) {
			// skip self
			if (peer.port === this.info.port && peer.host === this.info.host)
				continue;

			// skip if we've already sent advert to this peer recently AND that peer is online & advert still valid
			const kp = this.knownPeers.get(peer.id);
			if (kp && kp.online && kp.expiresAt && Date.now() / 1000 < kp.expiresAt) {
				// we have fresh info for them; skip re-sending
				if (this.discoveredSent.has(peer.id)) continue;
			}

			const key = `${peer.host}:${peer.port}`;
			const [err, mc] = await this.transport.dial(this.info, peer, 5000, true);
			if (err) {
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
			mc.send(packet);
			// don't keep ephemeral advert connections open long
			mc.onClose();
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

			const [err, mc] = await this.transport.dial(this.info, peer);
			if (err) {
				log(`❌ Failed to dial peer ${peer.id}: ${err.message}`);
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

			this.connections.set(peer.id, mc);
			mc.setOnFrame((f) => this.onFrame(mc, f));
			mc.socket.once("close", () => {
				this.connections.delete(peer.id);
				// mark offline
				const kp = this.knownPeers.get(peer.id);
				if (kp) {
					kp.online = false;
					this.knownPeers.set(peer.id, kp);
				}
				log(`🧹 Disconnected from ${peer.id}`);
			});

			// Upon connection, exchange peer lists
			mc.send({
				t: "PEER_LIST",
				from: this.info.id,
				payload: { peers: Array.from(this.peers.values()) },
			});

			log(`✅ Connected to peer ${peer.id} (${peer.host}:${peer.port})`);
		}
	}

	public async ensureConn(id: string) {
		const connection = this.connections.get(id);
		if (connection) return safeResult(connection);

		const peerId = this.peers.get(id);
		if (!peerId) return safeResult(undefined);

		const [error, mc] = await this.transport.dial(this.info, peerId);
		if (error) return safeError(error);

		this.connections.set(id, mc);
		mc.setOnFrame((f) => this.onFrame(mc, f));
		mc.socket.once("close", () => this.peers.delete(id));

		return safeResult(mc);
	}

	// --- Core packet handler ---
	private onFrame = async (mc: MuxedConnection, f: Packet) => {
		if (f.t === "PING") {
			mc.send({ t: "PONG", payload: { id: this.info.id } });
		} else if (f.t === "MSG") {
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
