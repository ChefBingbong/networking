// rendezvous.ts

import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { createHash } from "crypto";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import type {
	Secp256k1PrivateKey,
	Secp256k1PublicKey,
} from "../../secp256k1/secp256k1";
import type { PeerId } from "../../session/nodeInfo";
import type { Advert, RendezvousConfig, SignedAdvert } from "./types";

export const DEFAULT_RENDEZVOUS_CONFIG: RendezvousConfig = {
	namespace: "P2P-NETWORK-V1",
	epochSeconds: 3600,
	slotsPerNode: 8,
	querySlots: 32,
};
type RendezvousParams = {
	privateKey: Secp256k1PrivateKey;
	publicKey: Secp256k1PublicKey;
	peerId: PeerId;
	address: Multiaddr;
};

export class Rendezvous {
	public cfg: RendezvousConfig;
	public peerId: PeerId;
	private privateKey: Secp256k1PrivateKey;
	private publicKey: Secp256k1PublicKey;
	private multiaddr: Multiaddr;

	constructor(cfg: RendezvousConfig, params: RendezvousParams) {
		this.cfg = cfg;
		this.peerId = params.peerId;
		this.privateKey = params.privateKey;
		this.publicKey = params.publicKey;
		this.multiaddr = params.address;
	}

	epochFor(timestamp: number = Date.now() / 1000): number {
		return Math.floor(timestamp / this.cfg.epochSeconds);
	}

	sha256Hex(data: string): string {
		return createHash("sha256").update(data).digest("hex");
	}

	// rendezvous.ts — updated parts only
	// assumes createHash etc already imported

	/** Return the deterministic global slot array for epoch */
	computeGlobalSlots(epoch: number): string[] {
		// Q = total number of global slots per epoch (this.cfg.querySlots)
		const Q = this.cfg.querySlots;
		const slots = new Array<string>(Q);
		for (let i = 0; i < Q; i++) {
			slots[i] = this.sha256Hex(`${this.cfg.namespace}|${epoch}|${i}`);
		}
		return slots;
	}

	/**
	 * Publisher picks S slots out of the global Q slots deterministically
	 * using its public key as a selector.
	 */
	computePublishSlots(epoch: number): string[] {
		const global = this.computeGlobalSlots(epoch);
		const Q = global.length;
		const S = this.cfg.slotsPerNode;

		const chosen: string[] = [];
		// deterministic index derivation: for k in [0..S-1], index = H(pubkey|epoch|k) % Q
		const pubKeyStr = this.publicKey.toString();
		for (let k = 0; k < S; k++) {
			const idxHash = this.sha256Hex(`${pubKeyStr}|${epoch}|${k}`);
			const idx = parseInt(idxHash.slice(0, 8), 16) % Q; // use first 8 hex chars -> 32 bits
			chosen.push(global[idx]!);
		}

		// dedupe (rare) while preserving order; ensures returned length <= S
		return Array.from(new Set(chosen));
	}

	computeQuerySlots(
		epoch: number,
		seed: string,
		limit = this.cfg.querySlots,
	): string[] {
		const global = this.computeGlobalSlots(epoch);
		// deterministic sample using seed: H(seed|epoch|i) % Q
		if (!seed) return global.slice(0, limit);
		const Q = global.length;
		const out: string[] = [];
		for (let i = 0; i < limit; i++) {
			const idxHash = this.sha256Hex(`${seed}|${epoch}|${i}`);
			const idx = parseInt(idxHash.slice(0, 8), 16) % Q;
			out.push(global[idx]!);
		}
		return Array.from(new Set(out));
	}

	/**
	 * Create advert now includes chosenSlots array so receivers can see where the node published.
	 */
	createAdvert(): SignedAdvert {
		const epoch = this.epochFor();
		const chosenSlots = this.computePublishSlots(epoch);

		const advert: Advert = {
			version: 1,
			publicKey: this.publicKey.toString(),
			addr: this.multiaddr.toString(),
			epoch,
			// include the chosen slots list in the advert; keeps discovery easier
			slots: chosenSlots,
			// for backward compatibility you may still set slot to first chosen slot
			slot: chosenSlots[0],
			expires_at: (epoch + 2) * this.cfg.epochSeconds,
		};

		const sig = this.privateKey.sign(
			uint8ArrayFromString(JSON.stringify(advert)),
		);
		return { advert, signature: sig };
	}

	deriveCandidateAddresses(
		basePort = 4000,
		range = 200,
		count = 50,
		useSlotDerivedIds = false, // toggle mode
	): Multiaddr[] {
		const epoch = this.epochFor();
		const seed = `${this.cfg.namespace}|${epoch}`;
		const slots = this.computeQuerySlots(epoch, seed, count);

		return slots.map((slot) => {
			const hashNum = parseInt(slot.slice(0, 4), 16); // 16 bits of entropy
			const portOffset = hashNum % range;
			const port = basePort + portOffset;

			// Choose the identifier format
			const peerSuffix = useSlotDerivedIds
				? this.sha256Hex(`${this.peerId.toString()}|${slot}`).slice(0, 16)
				: this.peerId.toString();

			const addr = multiaddr(`/ip4/127.0.0.1/tcp/${port}/p2p/${peerSuffix}`);
			return addr;
		});
	}

	verifyAdvert(signed: SignedAdvert): boolean {
		const advertToVerify = uint8ArrayFromString(JSON.stringify(signed.advert));
		return this.publicKey.verify(advertToVerify, signed.signature);
	}
}
