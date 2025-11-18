// src/mux.ts

import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import EventEmitter from "events";
import net from "net";
import { decodeFrames, encodeFrame } from "../packet/encode";
import type { Packet } from "../packet/types";
import { ProtocolStream } from "../protocol/protocol-stream"; // we'll define this next
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
			sock.destroySoon();
		});
	}

	// ------------- public API -------------

	private sendRaw(frame: any) {
		// Socket not writable => treat as fatal for this connection.
		if (!this.socket.writable) {
			const err = new Error(
				`[${this.addrStr}] attempted to write to non-writable socket`,
			);
			log(err.message);
			this.emit("error", err);
			// ensure we tear down
			this.socket.destroy();
			return;
		}

		try {
			const encoded = encodeFrame(frame);
			this.socket.write(encoded);
		} catch (err: any) {
			log(
				`[${this.addrStr}] failed to send frame: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			// encoding or write failure usually means something is badly wrong
			this.socket.destroySoon();
		}
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
		const stream = new ProtocolStream(this, sid, protocol, true);
		this.streams.set(sid, stream);

		const pkt: StreamPacket = {
			t: "STREAM_OPEN",
			payload: { sid, protocol },
		};

		try {
			this.send(pkt);
		} catch (err: any) {
			log(
				`[${this.addrStr}] error while opening stream sid=${sid} protocol=${protocol}: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			// best-effort cleanup of the stream entry
			this.streams.delete(sid);
			this.socket.destroySoon();
			throw err;
		}

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

		try {
			this.send(pkt);
		} catch (err: any) {
			log(
				`[${this.addrStr}] error sending STREAM_DATA sid=${sid}: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			this.socket.destroySoon();
		}
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

		try {
			this.send(pkt);
		} catch (err: any) {
			log(
				`[${this.addrStr}] error sending STREAM_CLOSE sid=${sid}: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
		}
	}

	/**
	 * Internal: when a stream is fully dead, remove it from map.
	 */
	_removeStream(sid: number) {
		this.streams.delete(sid);
	}

	// ------------- frame handling / mux -------------

	private onData(chunk: Buffer) {
		try {
			this.partial = Buffer.concat([
				this.partial as Buffer,
				chunk as Buffer,
			]) as unknown as Buffer;

			this.partial = decodeFrames(this.partial, (outer) => {
				try {
					this.dispatch(outer);
				} catch (err: any) {
					log(
						`[${this.addrStr}] error dispatching decoded frame: ${
							err?.message || String(err)
						}`,
					);
					this.emit("error", err);
				}
			});
		} catch (err: any) {
			log(
				`[${this.addrStr}] Failed to parse frame: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			// Bad framing usually means stream is corrupted; tear down connection.
			this.socket.destroy();
		}
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
		if (!this.onFrameHandler) return;

		try {
			this.onFrameHandler(f);
		} catch (err: any) {
			log(
				`[${this.addrStr}] error in onFrameHandler: ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			// we *don't* destroy the connection here; we assume the higher layer
			// may choose what to do with the error
		}
	}

	private handleStreamPacket(pkt: StreamPacket) {
		try {
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
					const stream = new ProtocolStream(this, sid, protocol, false);
					this.streams.set(sid, stream);

					if (this.onStreamOpenHandler) {
						try {
							this.onStreamOpenHandler(protocol, stream);
						} catch (err: any) {
							log(
								`[${this.addrStr}] error in onStreamOpenHandler for protocol=${protocol}, sid=${sid}: ${
									err?.message || String(err)
								}`,
							);
							this.emit("error", err);
							// close the stream if handler blows up
							try {
								stream.close();
							} catch {
								// ignore
							}
							this.streams.delete(sid);
						}
					} else {
						log(
							`[${this.addrStr}] STREAM_OPEN for protocol=${protocol} but no handler registered`,
						);
						// if no handler, you might choose to immediately close:
						try {
							stream.close();
						} catch {
							// ignore
						}
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
					try {
						stream._onData(data);
					} catch (err: any) {
						log(
							`[${this.addrStr}] error delivering STREAM_DATA to sid=${sid}: ${
								err?.message || String(err)
							}`,
						);
						this.emit("error", err);
						// optional: you could close the stream on handler error
					}
					break;
				}

				case "STREAM_CLOSE": {
					const { sid } = pkt.payload;
					const stream = this.streams.get(sid);
					if (!stream) {
						// already closed or never existed
						return;
					}
					try {
						stream._onRemoteClose();
					} catch (err: any) {
						log(
							`[${this.addrStr}] error handling STREAM_CLOSE for sid=${sid}: ${
								err?.message || String(err)
							}`,
						);
						this.emit("error", err);
					}
					// ProtocolStream will call back into _removeStream when fully closed.
					break;
				}
			}
		} catch (err: any) {
			log(
				`[${this.addrStr}] error in handleStreamPacket (${pkt.t}): ${
					err?.message || String(err)
				}`,
			);
			this.emit("error", err);
			// depending on how strict you want to be, you might:
			// this.socket.destroy();
		}
	}

	public onClose() {
		// Close all streams
		for (const [sid, stream] of this.streams.entries()) {
			try {
				stream._onRemoteClose();
			} catch {
				// ignore individual stream errors on shutdown
			}
			this.streams.delete(sid);
		}

		if (!this.socket.destroyed) {
			this.socket.end();
		}
	}
}
