// src/mux.ts

import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import EventEmitter from "events";
import net from "net";
import { decodeFrames, encodeFrame } from "../packet/encode";
import type { Packet } from "../packet/types";
import type { ProtocolStream } from "../protocol/protocol-stream"; // we'll define this next
import type { NetworkEventEmitter } from "./events";

export type ConnectionHandler = (
	mc: MuxedConnection,
	f: Packet,
) => Promise<void>;
export type FrameHandler = (f: Packet) => void;

const log = debug("p2p:muxer");

// Stream-related packet types we’ll use
type StreamOpenPayload = {
	sid: number;
	protocol: string;
};

type StreamDataPayload = {
	sid: number;
	data: any;
};

type StreamClosePayload = {
	sid: number;
	direction?: "local" | "remote" | "both";
};

type StreamPacket =
	| { t: "STREAM_OPEN"; payload: StreamOpenPayload }
	| { t: "STREAM_DATA"; payload: StreamDataPayload }
	| { t: "STREAM_CLOSE"; payload: StreamClosePayload };

// callback type for when a remote opens a new stream
export type StreamOpenHandler = (
	protocol: string,
	stream: ProtocolStream,
) => void;

export class MuxedConnection extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public socket: net.Socket;
	private partial: Buffer = Buffer.alloc(0) as Buffer;
	private onFrameHandler: FrameHandler | null = null;

	// mux-related state
	private nextStreamId = 1; // simple monotonically increasing sid
	private streams = new Map<number, ProtocolStream>();
	private onStreamOpenHandler: StreamOpenHandler | null = null;

	// just for nicer logging
	private addrStr: string;

	constructor(addr: Multiaddr | undefined, sock: net.Socket) {
		super();
		this.socket = sock;
		this.addrStr = addr ? addr.toString() : "unknown";

		sock.on("data", (chunk) => this.onData(chunk as Buffer));
		sock.on("close", () => this.onClose());

		sock.once("close", (hadErr) => {
			log(`[${this.addrStr}] socket closed (${hadErr ? "error" : "clean"})`);
		});
		sock.on("error", (err) => {
			log(`[${this.addrStr}] socket error: ${err?.message || err}`);
		});
	}

	// ------------- public API -------------

	private sendRaw(frame: any) {
		this.socket.write(encodeFrame(frame));
	}

	send(frame: any) {
		this.sendRaw(frame);
	}

	setOnFrame(fn: FrameHandler) {
		this.onFrameHandler = fn;
	}

	/**
	 * Register a callback for when the remote opens a stream (STREAM_OPEN).
	 * Typically ProtocolManager will set this.
	 */
	setOnStreamOpen(fn: StreamOpenHandler) {
		this.onStreamOpenHandler = fn;
	}

	/**
	 * Open a new logical stream on this connection for a given protocol.
	 * This:
	 *  - allocates a stream id (sid)
	 *  - sends a STREAM_OPEN packet
	 *  - returns a ProtocolStream handle
	 */
	openStream(protocol: string): ProtocolStream {
		const sid = this.nextStreamId++;
		const { ProtocolStream } =
			require("../protocol/protocol-stream") as typeof import("../protocol/protocol-stream");

		const stream = new ProtocolStream(this, sid, protocol, true);
		this.streams.set(sid, stream);

		const pkt: StreamPacket = {
			t: "STREAM_OPEN",
			payload: { sid, protocol },
		};
		this.send(pkt);

		return stream;
	}

	/**
	 * Internal: called by ProtocolStream when it wants to send data.
	 */
	_sendStreamData(sid: number, data: any) {
		const pkt: StreamPacket = {
			t: "STREAM_DATA",
			payload: { sid, data },
		};
		this.send(pkt);
	}

	/**
	 * Internal: called by ProtocolStream when it wants to close.
	 */
	_sendStreamClose(
		sid: number,
		direction: "local" | "remote" | "both" = "both",
	) {
		const pkt: StreamPacket = {
			t: "STREAM_CLOSE",
			payload: { sid, direction },
		};
		this.send(pkt);
	}

	/**
	 * Internal: when a stream is fully dead, remove it from map.
	 */
	_removeStream(sid: number) {
		this.streams.delete(sid);
	}

	// ------------- frame handling / mux -------------

	private onData(chunk: Buffer) {
		this.partial = Buffer.concat([
			this.partial as Buffer,
			chunk as Buffer,
		]) as unknown as Buffer;

		this.partial = decodeFrames(this.partial, (outer) => {
			this.dispatch(outer);
		});
	}

	private dispatch(f: Packet) {
		// If it's a stream packet, handle at muxer level
		if (
			f.t === "STREAM_OPEN" ||
			f.t === "STREAM_DATA" ||
			f.t === "STREAM_CLOSE"
		) {
			this.handleStreamPacket(f as StreamPacket);
			return;
		}

		// Otherwise, pass it to higher-level router (Core/Rendezvous/ProtocolManager)
		this.onFrameHandler?.(f);
	}

	private handleStreamPacket(pkt: StreamPacket) {
		switch (pkt.t) {
			case "STREAM_OPEN": {
				const { sid, protocol } = pkt.payload;
				if (this.streams.has(sid)) {
					// collision / protocol violation
					log(
						`[${this.addrStr}] STREAM_OPEN collision for sid=${sid} protocol=${protocol}`,
					);
					return;
				}

				// lazily require to avoid circular import issues
				const { ProtocolStream } =
					require("../protocol/protocol-stream") as typeof import("../protocol/protocol-stream");

				const stream = new ProtocolStream(this, sid, protocol, false);
				this.streams.set(sid, stream);

				if (this.onStreamOpenHandler) {
					this.onStreamOpenHandler(protocol, stream);
				} else {
					log(
						`[${this.addrStr}] STREAM_OPEN for protocol=${protocol} but no handler registered`,
					);
					// if no handler, you might choose to immediately close:
					// stream.close();
				}
				break;
			}

			case "STREAM_DATA": {
				const { sid, data } = pkt.payload;
				const stream = this.streams.get(sid);
				if (!stream) {
					log(`[${this.addrStr}] STREAM_DATA for unknown sid=${sid}`);
					return;
				}
				stream._onData(data);
				break;
			}

			case "STREAM_CLOSE": {
				const { sid } = pkt.payload;
				const stream = this.streams.get(sid);
				if (!stream) {
					// already closed or never existed
					return;
				}
				stream._onRemoteClose();
				// ProtocolStream will call back into _removeStream when fully closed.
				break;
			}
		}
	}

	public onClose() {
		this.socket.end();
		// Close all streams
		for (const [sid, stream] of this.streams.entries()) {
			stream._onRemoteClose();
			this.streams.delete(sid);
		}
	}
}
