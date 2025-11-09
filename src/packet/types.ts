export type PeerInfo = { id: string; host: string; port: number };

export enum PacketType {
	HELLO = "HELLO",
	HELLO_ACK = "HELLO_ACK",
	SECURE = "SECURE",

	PING = "PING",
	PONG = "PONG",
	MSG = "MSG",

	PEER_JOIN = "PEER_JOIN",
	PEER_LIST = "PEER_LIST",
	PEER_LEAVE = "PEER_LEAVE",
	HEARTBEAT = "HEARTBEAT",

	OPEN = "OPEN",
	DATA = "DATA",
	CLOSE = "CLOSE",
}

export type PacketBase = {
	t: PacketType;
	from?: string;
	to?: string;
};

export type HelloPayload = { id: string; v: number };
export type MsgPayload = { text: string };
export type PeerListPayload = { peers: PeerInfo[] };
export type HeartbeatPayload = PeerInfo;
export type PeerJoinPayload = PeerInfo;
export type PeerLeavePayload = { id: string };

export type PingPayload = { ts?: number };
export type PongPayload = { id: string; tsRecv?: number };

export type Packet =
	| (PacketBase & { t: PacketType.HELLO; payload: HelloPayload })
	| (PacketBase & { t: PacketType.HELLO_ACK; payload: HelloPayload })
	| (PacketBase & { t: PacketType.SECURE })
	| (PacketBase & { t: PacketType.PING; payload?: PingPayload })
	| (PacketBase & { t: PacketType.PONG; payload: PongPayload })
	| (PacketBase & { t: PacketType.MSG; payload: MsgPayload })
	| (PacketBase & { t: PacketType.PEER_JOIN; payload: PeerJoinPayload })
	| (PacketBase & { t: PacketType.PEER_LIST; payload: PeerListPayload })
	| (PacketBase & { t: PacketType.PEER_LEAVE; payload: PeerLeavePayload })
	| (PacketBase & { t: PacketType.HEARTBEAT; payload: HeartbeatPayload });
