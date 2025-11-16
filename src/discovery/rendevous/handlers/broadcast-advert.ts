import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import type { BroadcastAdvertPayload } from "../../../packet/types.js";
import type { PeerId } from "../../../session/nodeInfo.js";
import type { SignedAdvert } from "../types.js";

export interface RendezvousMessageHandler {
	handle(peerId: PeerId, msg: any): Promise<any | undefined>;
}

export class BroadcastAdvertHandler implements RendezvousMessageHandler {
	public peers: Map<string, Multiaddr>;
	public adverts: Map<string, SignedAdvert>;
	private address: Multiaddr;
	public peerId: PeerId;

	constructor(
		peerId: PeerId,
		address: Multiaddr,
		peers: Map<string, Multiaddr>,
		adverts: Map<string, SignedAdvert>,
	) {
		this.address = address;
		this.peers = peers;
		this.adverts = adverts;
		this.peerId = peerId;
	}

	public handle = async (peerId: PeerId, frame: BroadcastAdvertPayload) => {
		const signed: SignedAdvert = JSON.parse(frame.advert);
		await this.handleIncomingAdvert(signed);
		return frame;
	};

	private async handleIncomingAdvert(advert: SignedAdvert) {
		const addrStr = advert?.advert?.addr;
		if (!addrStr) return;

		const addr = multiaddr(addrStr);
		const key = addr.toString();
		if (key === this.address.toString()) return;

		this.adverts.set(key, advert);
		this.indexAdvertSlots(key, advert);
		this.markPeerOnline(addr, advert.advert.expires_at);
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
}
