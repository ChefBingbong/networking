// handlers.ts
import type { Multiaddr } from "@multiformats/multiaddr";
import { multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { MuxedConnection } from "../../node/connection";
import { mkDiscoveryResponse } from "../../packet/packets";
import type { Packet } from "../../packet/types";
import type { SignedAdvert } from "./types";

const log = debug("p2p:rendezvous:handlers");

export interface RendezvousMessageHandler {
	handle(conn: MuxedConnection, frame: Packet): Promise<void>;
}

export class BroadcastAdvertHandler {
	private onAdvert: (
		addr: Multiaddr,
		advert: SignedAdvert,
	) => Promise<void> | void;

	constructor(
		onAdvert: (addr: Multiaddr, advert: SignedAdvert) => Promise<void> | void,
	) {
		this.onAdvert = onAdvert;
	}

	public handle = async (conn: MuxedConnection, frame: Packet) => {
		const payload: any = frame.payload ?? {};

		if (frame.t === "BROADCAST_ADVERT") {
			const raw = payload.advert;
			if (!raw) return;

			let signed: SignedAdvert;
			try {
				signed = JSON.parse(raw);
			} catch {
				return;
			}

			const addr = multiaddr(signed.advert.addr);
			await this.onAdvert(addr, signed);
			log("Handled broadcast advert from", addr.toString());
		}

		if (frame.t === "DISCOVERY_RESPONSE") {
			const raws: string[] = payload.adverts ?? [];
			for (const raw of raws) {
				try {
					const signed: SignedAdvert = JSON.parse(raw);
					const addr = multiaddr(signed.advert.addr);
					await this.onAdvert(addr, signed);
					log("Handled discovery response advert from", addr.toString());
				} catch {
					continue;
				}
			}
		}
	};
}

export class DiscoverRequestHandler {
	private findAdvertsForSlots: (slots: string[]) => SignedAdvert[];

	constructor(findAdvertsForSlots: (slots: string[]) => SignedAdvert[]) {
		this.findAdvertsForSlots = findAdvertsForSlots;
	}

	public handle = async (conn: MuxedConnection, frame: Packet) => {
		const payload: any = frame.payload ?? {};
		const slots: string[] = payload.slots ?? [];

		const adverts = this.findAdvertsForSlots(slots);
		const serialized = adverts.map((a) => JSON.stringify(a));
		const peers = adverts.map((a) => a.advert.addr);

		conn.send(mkDiscoveryResponse(serialized, peers));
		log("Handled discovery request for slots");
	};
}
