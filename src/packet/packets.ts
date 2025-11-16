import { type Packet, PacketType, type PeerInfo } from "./types";

// ── Helpers (typed factories) ──────────────────────────────────────────────
export const mkHello = (
	id: string,
	v: number,
	from?: string,
	to?: string,
): Packet => ({ t: PacketType.HELLO, payload: { id, v }, from, to });

export const mkHelloAck = (
	id: string,
	v: number,
	from?: string,
	to?: string,
): Packet => ({ t: PacketType.HELLO_ACK, payload: { id, v }, from, to });

export const mkSecure = (from?: string, to?: string): Packet => ({
	t: PacketType.SECURE,
	from,
	to,
});

export const mkPing = (from: string): Packet => ({
	t: PacketType.PING,
	payload: { from, ts: Date.now() },
});

export const mkPong = (from: string, ts: number): Packet => ({
	t: PacketType.PONG,
	payload: { from, ts },
});

export const mkMsg = (text: string, from?: string, to?: string): Packet => ({
	t: PacketType.MSG,
	payload: { text },
	from,
	to,
});

export const mkPeerJoin = (p: PeerInfo, from?: string): Packet => ({
	t: PacketType.PEER_JOIN,
	payload: p,
	from,
	to: "HOST",
});

export const mkPeerList = (peers: PeerInfo[]): Packet => ({
	t: PacketType.PEER_LIST,
	payload: { peers },
});

export const mkPeerLeave = (id: string): Packet => ({
	t: PacketType.PEER_LEAVE,
	payload: { id },
});

export const mkHeartbeat = (p: PeerInfo): Packet => ({
	t: PacketType.HEARTBEAT,
	payload: p,
	to: "HOST",
});

export const mkBroadcastAdvert = (advert: string): Packet => ({
	t: PacketType.BROADCAST_ADVERT,
	payload: { advert },
});

// packets.ts (or wherever your PacketType + mk* live)
export const mkDiscoveryRequest = (slots: string[], from: string): Packet => ({
	t: PacketType.DISCOVERY_REQUEST,
	payload: { slots, from },
});

export const mkDiscoveryResponse = (
	adverts: string[],
	peers: string[] = [],
): Packet => ({
	t: PacketType.DISCOVERY_RESPONSE,
	payload: { adverts, peers },
});

// ── Tiny runtime validation (no external libs) ────────────────────────────
export function isPacket(x: any): x is Packet {
	return x && typeof x === "object" && typeof x.t === "string";
}

export function assertPacketType<T extends PacketType>(
	pkt: Packet,
	t: T,
): asserts pkt is Extract<Packet, { t: T }> {
	if (pkt.t !== t)
		throw new Error(`packet type mismatch: expected ${t}, got ${pkt.t}`);
}
