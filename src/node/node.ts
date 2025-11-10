import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
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
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import { type PeerId, type PeerInfo } from "../session/nodeInfo";
import { peerIdFromPrivateKey } from "../session/peer-id";
import { safeError, safeResult } from "../utils/safe";
import type { MuxedConnection } from "./connection";
import type { TransportListener } from "./transport";
import { Transport } from "./transport/transport";

const log = debug("p2p:node");

interface KnownPeer {
	addr: Multiaddr;
	lastSeen: number;
	expiresAt?: number;
	online: boolean;
}

export class PeerNode extends EventEmitter {
	public info: PeerInfo;
	private transport: Transport;
	private rendezvous: Rendezvous;

	private connections = new Map<string, MuxedConnection>();
	private peers = new Set<Multiaddr>();
	private adverts = new Map<string, SignedAdvert>();
	private knownPeers = new Map<string, KnownPeer>();

	private privateKey: Secp256k1PrivateKey;
	private sentAdverts = new Set<string>();

	public peerId: PeerId;
	public address: Multiaddr;
	private listener: TransportListener;
	private advert: SignedAdvert;

	constructor(nodeOptions: PeerInfo) {
		super();
		this.privateKey = nodeOptions.privateKey;
		this.transport = new Transport(this.privateKey);
		this.peerId = peerIdFromPrivateKey(this.privateKey);

		// Use multiaddr for this node
		this.address = multiaddr(
			`/ip4/${nodeOptions.host}/tcp/${nodeOptions.port}/p2p/${this.peerId.toString()}`,
		);

		this.rendezvous = new Rendezvous(DEFAULT_RENDEZVOUS_CONFIG, {
			peerId: this.peerId,
			privateKey: this.privateKey,
			publicKey: this.privateKey.publicKey,
			address: this.address,
		});

		this.advert = this.rendezvous.createAdvert();
		this.listener = this.transport.createListener(this.onFrame, true);
		this.info = nodeOptions;
	}

	// === Startup ===
	public async start() {
		await this.listener.listen(this.address);

		log(`🚀 Peer started at ${this.address.toString()}`);
		this.runAdvertLoop();
		this.runDiscoveryLoop();
	}

	// === Periodic Advert Loop ===
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

	// === Periodic Discovery Loop ===
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

	// === Broadcast Advert ===
	private async broadcastAdvert() {
		const advertPacket = mkBroadcastAdvert(JSON.stringify(this.advert));

		let candidatePeers = Array.from(this.peers.values());
		if (candidatePeers.length === 0) {
			candidatePeers = this.rendezvous.deriveCandidateAddresses(4000, 15);
		}

		for (const peerId of candidatePeers) {
			if (!peerId || peerId === this.address) continue;

			const key = peerId.toString();
			const known = this.knownPeers.get(key);
			if (
				known?.online &&
				known.expiresAt &&
				Date.now() / 1000 < known.expiresAt &&
				this.sentAdverts.has(key)
			) {
				continue;
			}

			const [error, conn] = await this.transport.dial(peerId, 5000, true);
			if (error) {
				this.markPeerOffline(key);
				continue;
			}

			this.markPeerOnline(peerId, this.advert.advert.expires_at);
			this.sentAdverts.add(key);
			conn.send(advertPacket);

			conn.once("close", () => this.connections.delete(key));
			log(`📢 Advert sent to ${key}`);
		}
	}

	// === Discovery Logic ===
	private async discoverPeers(maxNewConnections = 5) {
		this.cleanupExpiredPeers();

		const newPeers: Multiaddr[] = [];
		for (const advert of this.adverts.values()) {
			const peerAddrs = advert.advert.addr;
			if (peerAddrs === this.address.toString()) continue;
			if (this.connections.has(peerAddrs)) continue;

			const addrStr = advert.advert.addr;
			if (!addrStr) continue;

			let addr: Multiaddr;
			try {
				addr = multiaddr(addrStr);
			} catch {
				continue;
			}

			const known = this.knownPeers.get(peerAddrs);
			const isRecent =
				known?.online && known.expiresAt && Date.now() / 1000 < known.expiresAt;
			if (isRecent && this.sentAdverts.has(peerAddrs)) continue;

			newPeers.push(addr);
		}

		for (const peerAddr of newPeers.slice(0, maxNewConnections)) {
			const [error, conn] = await this.transport.dial(peerAddr, 5000, true);
			if (error) {
				this.markPeerOffline(peerAddr.toString());
				continue;
			}

			this.markPeerOnline(peerAddr);
			this.connections.set(peerAddr.toString(), conn);

			conn.on("frame", (frame: Packet) => this.onFrame(conn, frame));
			conn.once("close", () => this.markPeerOffline(peerAddr.toString()));

			// Send known peers
			conn.send({
				t: "PEER_LIST",
				from: this.peerId.toString(),
				payload: {
					peers: Array.from(this.peers.values()).map((a) => a.toString()),
				},
			});

			log(`✅ Connected to ${peerAddr.toString()}`);
		}
	}

	// === Frame Handler ===
	private onFrame = async (conn: MuxedConnection, frame: Packet) => {
		switch (frame.t) {
			case "PING":
				conn.send({ t: "PONG", payload: { id: this.peerId.toString() } });
				break;

			case "MSG":
				log(
					`[${this.peerId.toString()}] <${frame.from}>: ${frame.payload?.text}`,
				);
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
				const peers = frame.payload.peers.map((a) => multiaddr(a));
				this.integratePeerList(peers);
				break;
			}
		}
	};

	// === Handle Incoming Advert ===
	private async handleIncomingAdvert(advert: SignedAdvert) {
		const addrStr = advert?.advert?.addr;
		if (!addrStr || addrStr === this.peerId.toString()) return;

		let addr: Multiaddr;
		try {
			addr = multiaddr(addrStr);
		} catch {
			return;
		}

		this.peers.add(multiaddr(addrStr));
		this.adverts.set(addrStr, advert);
		this.markPeerOnline(multiaddr(addrStr), advert.advert.expires_at);

		log(`🗂 Stored advert from ${addr.toString()}`);
	}

	// === Integrate Peer List ===
	private integratePeerList(peers: Multiaddr[]) {
		for (const addr of peers) {
			const peerId = addr.toString();
			if (!peerId || peerId === this.address.toString()) continue;

			const key = peerId.toString();
			if (!this.peers.has(multiaddr(addr))) {
				this.peers.add(addr);
				log(`🌐 Discovered new peer ${key}`);
				this.ensureConnection(key).catch((e) =>
					log("ensureConnection error:", e),
				);
			}
		}
	}

	// === Ensure Connection ===
	private async ensureConnection(peerId: string) {
		if (this.connections.has(peerId))
			return safeResult(this.connections.get(peerId));

		const addr = this.peers.values().find((a) => a.toString() === peerId);
		if (!addr) return safeResult(undefined);

		const [error, conn] = await this.transport.dial(addr, 5000, true);
		if (error) return safeError(error);

		this.connections.set(peerId, conn);
		conn.on("frame", (frame: Packet) => this.onFrame(conn, frame));
		conn.once("close", () => this.markPeerOffline(peerId));

		return safeResult(conn);
	}

	// === Peer Tracking ===
	private markPeerOnline(addr: Multiaddr, expiresAt?: number) {
		const now = Date.now() / 1000;
		this.knownPeers.set(addr.toString(), {
			addr,
			lastSeen: now,
			expiresAt,
			online: true,
		});
		this.peers.add(addr);
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
				this.peers.delete(multiaddr(id));
			}
		}
	}
}
