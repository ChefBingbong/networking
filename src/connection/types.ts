import type { Multiaddr } from "@multiformats/multiaddr";
import type { TLSSocket } from "node:tls";
import type { Packet } from "../packet/types";
import type { MuxedConnection } from "./connection";
import type { ProtocolStream } from "./protocol-stream";

export type ConnectionHandler = (
	mc: MuxedConnection,
	f: Packet,
) => Promise<void>;

export type FrameHandler = (f: Packet) => void;

export type StreamOpenPayload = {
	sid: number;
	protocol: string;
};

export type StreamDataPayload = {
	sid: number;
	data: any;
};

export type StreamClosePayload = {
	sid: number;
	direction?: "local" | "remote" | "both";
};

export type StreamPacket =
	| { t: "STREAM_OPEN"; payload: StreamOpenPayload }
	| { t: "STREAM_DATA"; payload: StreamDataPayload }
	| { t: "STREAM_CLOSE"; payload: StreamClosePayload };

export type StreamOpenHandler = (
	protocol: string,
	stream: ProtocolStream,
) => void;

export type MuxedConnectionOptions = {
	localAddr?: Multiaddr;
	remoteAddr?: Multiaddr;
};

export type EncryptionCredentials = {
	certPEM: string;
	keyPEM: string;
	nodeKey: {
		private: Uint8Array<ArrayBufferLike>;
		publicCompressed: Uint8Array<ArrayBufferLike>;
	};
};

export type EncrypterResult = {
	socket: TLSSocket;
	remoteInfo: any;
};
