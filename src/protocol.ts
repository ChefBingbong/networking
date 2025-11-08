// src/protocol.ts

export type NodeId = string;

export const PROTOCOL_VERSION = 1 as const;

export type FrameType =
	| "HELLO" // handshake start (plaintext)
	| "HELLO_ACK" // handshake response (plaintext)
	| "SECURE" // confirm switch to encrypted mode
	| "OPEN" // open logical stream
	| "DATA" // stream data (or encrypted wrapper when sid=0 & payload.enc)
	| "CLOSE" // close logical stream
	| "PING" // optional app-level ping between nodes
	| "PONG" // optional app-level pong between nodes
	| "HEARTBEAT" // node -> bootstrap liveness signal
	| "PEER_JOIN" // bootstrap informs others or node registers
	| "PEER_LEAVE" // bootstrap informs others
	| "PEER_LIST" // bootstrap -> node list of peers
	| "MSG"; // simple app message (over secure channel)

export interface Frame {
	t: FrameType;
	sid?: number; // stream id (for muxed streams)
	from?: NodeId;
	to?: NodeId;
	payload?: any; // JSON-serializable
}

// length-prefixed JSON framing
export function encodeFrame(obj: Frame): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(body.length, 0);
	return Buffer.concat([len, body]);
}

export function decodeFrames(buf: Buffer, onFrame: (f: Frame) => void): Buffer {
	let off = 0;
	while (buf.length - off >= 4) {
		const len = buf.readUInt32BE(off);
		off += 4;
		if (buf.length - off < len) {
			off -= 4;
			break;
		}
		const slice = buf.subarray(off, off + len);
		off += len;
		try {
			onFrame(JSON.parse(slice.toString("utf8")) as Frame);
		} catch (e) {
			console.error("Failed to parse frame:", e);
		}
	}
	return buf.subarray(off);
}

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
