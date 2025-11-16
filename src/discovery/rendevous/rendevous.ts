import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { createHash } from "crypto";
import debug from "debug";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import type { MuxedConnection } from "../../node/connection";
import type { Packet } from "../../packet/types";
import type {
	Secp256k1PrivateKey,
	Secp256k1PublicKey,
} from "../../secp256k1/secp256k1";
import type { PeerId, PeerInfo } from "../../session/nodeInfo";
import { peerIdFromPrivateKey } from "../../session/peer-id";
import { BroadcastAdvertHandler, DiscoverRequestHandler } from "./handlers";
import type { Advert, RendezvousConfig, SignedAdvert } from "./types";

const log = debug("p2p:rendezvous");

export enum MessageType {
	BROADCAST_ADVERT = "BROADCAST_ADVERT",
	DISCOVERY_REQUEST = "DISCOVERY_REQUEST",
	DISCOVERY_RESPONSE = "DISCOVERY_RESPONSE",
}

export const DEFAULT_RENDEZVOUS_CONFIG: RendezvousConfig = {
	namespace: "P2P-NETWORK-V1",
	epochSeconds: 15, // was 60
	slotsPerNode: 40, // was 8
	querySlots: 64, // was 32
	discoveryBasePort: 4000,
	discoveryPortRange: 64, // wide enough for your 50-node cluster
	discoveryHost: "127.0.0.1",
};
export class Rendezvous {
	public cfg: RendezvousConfig;
	public peerId: PeerId;
	private privateKey: Secp256k1PrivateKey;
	private publicKey: Secp256k1PublicKey;
	private selfAddr: Multiaddr;

	// adverts & slots
	private adverts = new Map<string, SignedAdvert>();
	private slotIndex = new Map<string, Set<string>>();

	// self advert
	private currentEpoch: number;
	private advert: SignedAdvert;

	public handlers: Record<MessageType, any>;

	constructor(options: PeerInfo) {
		this.privateKey = options.privateKey;
		this.publicKey = this.privateKey.publicKey;
		this.peerId = peerIdFromPrivateKey(this.privateKey);

		this.selfAddr = multiaddr(
			`/ip4/${options.host}/tcp/${options.port}/p2p/${this.peerId.toString()}`,
		);

		const basePort = Math.max(1024, options.port - 32); // slightly wider band
		const discoveryRange = 64; // enough to cover ~50 nodes around you

		this.cfg = {
			...DEFAULT_RENDEZVOUS_CONFIG,
			discoveryBasePort: basePort,
			discoveryPortRange: discoveryRange,
			discoveryHost: options.host,
		};

		this.currentEpoch = this.epochFor();
		this.advert = this.createAdvertForEpoch(this.currentEpoch);

		// // Optionally index our own advert so others can discover us by slot
		// this.adverts.set(this.selfAddr.toString(), this.advert);
		// this.indexAdvertSlots(this.selfAddr.toString(), this.advert);

		// handlers wired to Rendezvous state via callbacks
		this.handlers = {
			[MessageType.BROADCAST_ADVERT]: new BroadcastAdvertHandler(
				(addr, advert) => this.handleIncomingAdvert(addr, advert),
			),
			[MessageType.DISCOVERY_RESPONSE]: new BroadcastAdvertHandler(
				(addr, advert) => this.handleIncomingAdvert(addr, advert),
			),
			[MessageType.DISCOVERY_REQUEST]: new DiscoverRequestHandler((slots) =>
				this.findAdvertsForSlots(slots),
			),
		};
	}

	// ---------- public API for PeerNode ----------

	public refreshAdvertIfNeeded() {
		const nowEpoch = this.epochFor();
		if (nowEpoch !== this.currentEpoch) {
			this.currentEpoch = nowEpoch;
			this.advert = this.createAdvertForEpoch(nowEpoch);
		}
	}

	public getCurrentAdvert(): SignedAdvert {
		return this.advert;
	}

	public getAdvertBroadcastTargets(max = this.cfg.querySlots): Multiaddr[] {
		this.cleanupExpiredAdverts();

		const directTargets = new Set<string>();
		for (const adv of this.adverts.values()) {
			const addrStr = adv.advert.addr;
			if (!addrStr) continue;
			directTargets.add(addrStr);
			if (directTargets.size >= max) break;
		}

		if (directTargets.size > 0) {
			return Array.from(directTargets).map((s) => multiaddr(s));
		}

		return this.deriveCandidateAddresses(max);
	}

	// inside Rendezvous
	public getDiscoverySlots(): string[] {
		const epoch = this.epochFor();
		return this.computeQuerySlots(
			epoch,
			this.peerId.toString(),
			this.cfg.querySlots,
		);
	}

	public getDiscoveryTargets(max = 20): Multiaddr[] {
		this.cleanupExpiredAdverts();

		const epoch = this.epochFor();
		const querySlots = this.computeQuerySlots(
			epoch,
			this.peerId.toString(),
			this.cfg.querySlots,
		);

		const visited = new Set<string>();
		const out: Multiaddr[] = [];

		for (const slot of querySlots) {
			const keys = this.slotIndex.get(slot);
			if (!keys) continue;

			for (const addrKey of keys) {
				if (visited.has(addrKey)) continue;
				visited.add(addrKey);

				const adv = this.adverts.get(addrKey);
				if (!adv) continue;

				try {
					const addr = multiaddr(adv.advert.addr);
					out.push(addr);
					if (out.length >= max) {
						return out;
					}
				} catch {
					continue;
				}
			}
		}

		return out;
	}

	/**
	 * Frame handler for the TCP router.
	 */
	public handle = async (conn: MuxedConnection, frame: Packet) => {
		const t = frame.t as string;
		if (
			t !== MessageType.BROADCAST_ADVERT &&
			t !== MessageType.DISCOVERY_REQUEST &&
			t !== MessageType.DISCOVERY_RESPONSE
		) {
			return;
		}

		const handler = this.handlers[t as MessageType];
		if (!handler) return;

		try {
			await handler.handle(conn, frame);
		} catch {
			// avoid crashing caller
		}
	};

	// ---------- internal advert / slot management ----------

	private removeAdvertFromSlotIndex(addrKey: string, advert: SignedAdvert) {
		const slots =
			advert.advert.slots && advert.advert.slots.length > 0
				? advert.advert.slots
				: advert.advert.slot
					? [advert.advert.slot]
					: [];

		for (const s of slots) {
			const set = this.slotIndex.get(s);
			if (!set) continue;
			set.delete(addrKey);
			if (set.size === 0) {
				this.slotIndex.delete(s);
			}
		}
	}

	private async handleIncomingAdvert(addr: Multiaddr, advert: SignedAdvert) {
		const key = addr.toString();
		if (key === this.selfAddr.toString()) return;

		const existing = this.adverts.get(key);

		// If we already have an advert for this peer, and its epoch is >= the new one,
		// ignore this advert entirely (no logging, no reindex).
		if (existing) {
			const oldEpoch = existing.advert.epoch ?? 0;
			const newEpoch = advert.advert.epoch ?? 0;
			if (newEpoch <= oldEpoch) {
				return;
			}

			// If the new advert is fresher, remove old slot index first
			this.removeAdvertFromSlotIndex(key, existing);
		}

		this.adverts.set(key, advert);
		this.indexAdvertSlots(key, advert);
		log(`Discovered advert from ${key}`);
	}

	private indexAdvertSlots(addrKey: string, advert: SignedAdvert) {
		const slots =
			advert.advert.slots && advert.advert.slots.length > 0
				? advert.advert.slots
				: advert.advert.slot
					? [advert.advert.slot]
					: [];

		for (const s of slots) {
			let set = this.slotIndex.get(s);
			if (!set) {
				set = new Set<string>();
				this.slotIndex.set(s, set);
			}
			set.add(addrKey);
		}
	}

	private findAdvertsForSlots(slots: string[]): SignedAdvert[] {
		const out: SignedAdvert[] = [];
		const seen = new Set<string>();

		// If no slots requested, you might choose to return only self advert
		if (!slots || slots.length === 0) {
			out.push(this.advert);
			return out;
		}

		for (const s of slots) {
			const keys = this.slotIndex.get(s);
			if (!keys) continue;
			for (const key of keys) {
				if (seen.has(key)) continue;
				seen.add(key);

				const adv = this.adverts.get(key);
				if (adv) out.push(adv);
			}
		}

		// Always include ourselves at least once
		if (!out.some((a) => a.advert.addr === this.selfAddr.toString())) {
			out.push(this.advert);
		}

		return out;
	}

	public getKnownAdvertPeers(): Multiaddr[] {
		this.cleanupExpiredAdverts();
		const out: Multiaddr[] = [];

		for (const adv of this.adverts.values()) {
			try {
				const addr = multiaddr(adv.advert.addr);
				out.push(addr);
			} catch {
				continue;
			}
		}

		return out;
	}

	private cleanupExpiredAdverts() {
		const now = Date.now() / 1000;
		for (const [key, advert] of this.adverts.entries()) {
			const expiresAt = advert.advert.expires_at;
			if (expiresAt && expiresAt < now) {
				this.adverts.delete(key);

				const slots =
					advert.advert.slots && advert.advert.slots.length > 0
						? advert.advert.slots
						: advert.advert.slot
							? [advert.advert.slot]
							: [];
				for (const s of slots) {
					const set = this.slotIndex.get(s);
					if (!set) continue;
					set.delete(key);
					if (set.size === 0) {
						this.slotIndex.delete(s);
					}
				}
			}
		}
	}

	// ---------- epoch / slots / advert creation ----------

	epochFor(timestamp: number = Date.now() / 1000): number {
		return Math.floor(timestamp / this.cfg.epochSeconds);
	}

	private sha256Hex(data: string): string {
		return createHash("sha256").update(data).digest("hex");
	}

	computeGlobalSlots(epoch: number): string[] {
		const Q = this.cfg.querySlots;
		const slots = new Array<string>(Q);
		for (let i = 0; i < Q; i++) {
			slots[i] = this.sha256Hex(`${this.cfg.namespace}|${epoch}|${i}`);
		}
		return slots;
	}

	computePublishSlots(epoch: number): string[] {
		const global = this.computeGlobalSlots(epoch);
		const Q = global.length;
		const S = this.cfg.slotsPerNode;

		const chosen: string[] = [];
		const pubKeyStr = this.publicKey.toString();
		for (let k = 0; k < S; k++) {
			const idxHash = this.sha256Hex(`${pubKeyStr}|${epoch}|${k}`);
			const idx = parseInt(idxHash.slice(0, 8), 16) % Q;
			chosen.push(global[idx]!);
		}

		return Array.from(new Set(chosen));
	}

	computeQuerySlots(
		epoch: number,
		seed: string,
		limit = this.cfg.querySlots,
	): string[] {
		const global = this.computeGlobalSlots(epoch);
		if (!seed) return global.slice(0, limit);

		const Q = global.length;
		const out: string[] = [];
		for (let i = 0; i < limit; i++) {
			const idxHash = this.sha256Hex(`${seed}|${epoch}|${i}`);
			const idx = parseInt(idxHash.slice(0, 8), 16) % Q;
			out.push(global[idx]!);
		}
		return Array.from(new Set(out)).slice(0, limit);
	}

	private createAdvertForEpoch(epoch: number): SignedAdvert {
		const chosenSlots = this.computePublishSlots(epoch);

		const advert: Advert = {
			version: 1,
			publicKey: this.publicKey.toString(),
			addr: this.selfAddr.toString(),
			epoch,
			slots: chosenSlots,
			slot: chosenSlots[0],
			expires_at: (epoch + 2) * this.cfg.epochSeconds,
		};

		const sig = this.privateKey.sign(
			uint8ArrayFromString(JSON.stringify(advert)),
		);
		return { advert, signature: sig };
	}

	deriveCandidateAddresses(count = this.cfg.querySlots): Multiaddr[] {
		const epoch = this.epochFor();
		const seed = `${this.cfg.namespace}|${epoch}`;
		const slots = this.computeQuerySlots(epoch, seed, count);

		const basePort = this.cfg.discoveryBasePort!;
		const range = this.cfg.discoveryPortRange!;
		const host = this.cfg.discoveryHost!;

		return slots.map((slot) => {
			const hashNum = parseInt(slot.slice(0, 4), 16); // 16 bits
			const portOffset = hashNum % range;
			const port = basePort + portOffset;
			const peerSuffix = this.peerId.toString();

			return multiaddr(`/ip4/${host}/tcp/${port}/p2p/${peerSuffix}`);
		});
	}

	verifyAdvert(_signed: SignedAdvert): boolean {
		return true;
	}
}
