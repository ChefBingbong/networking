import type { Multiaddr } from "@multiformats/multiaddr";
import { Unix } from "@multiformats/multiaddr-matcher";
import debug from "debug";
import EventEmitter from "node:events";
import net from "node:net";
import type { NetworkEventEmitter } from "../node/events";
import { decodeFrames, encodeFrame } from "../packet/encode";
import type { Packet } from "../packet/types";
import { multiaddrFromIp } from "../utils/utils";
import { ProtocolStream } from "./protocol-stream";
import type {
	FrameHandler,
	MuxedConnectionOptions,
	StreamOpenHandler,
	StreamPacket,
} from "./types";

const log = debug("p2p:muxer");
type Direction = "local" | "remote" | "both";

export class MuxedConnection extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public socket: net.Socket;
	public streams = new Map<number, ProtocolStream>();

	private onStreamOpenHandler: StreamOpenHandler | null = null;
	private onFrameHandler: FrameHandler | null = null;

	private partial: Buffer = Buffer.alloc(0);
	private nextStreamId = 1;
	private remoteAddr: Multiaddr;

	constructor(sock: net.Socket, options: MuxedConnectionOptions) {
		super();

		if (options.localAddr && Unix.matches(options.localAddr)) {
			this.remoteAddr = options.localAddr;
		} else if (!this.remoteAddr) {
			this.remoteAddr = multiaddrFromIp(sock.remoteAddress, sock.remotePort);
		}
		this.socket = sock;

		this.socket.on("data", this.onData.bind(this));

		this.socket.on("error", (err) => {
			log(`[${this.remoteAddr}] socket error: ${err?.message || err}`);
			sock.destroySoon();
		});

		this.socket.once("timeout", () => {
			log("tcp timeout", this.remoteAddr);
			this.onClose();
		});

		this.socket.once("end", () => {
			log("tcp end", this.remoteAddr);
			this.onClose();
		});

		this.socket.once("close", () => {
			log("tcp close", this.remoteAddr);
			this.onClose();
		});

		this.socket.on("drain", () => {
			log("tcp drain", this.remoteAddr);
			this.onClose();
		});
	}

	send(frame: any) {
		this.sendRaw(frame);
	}

	setOnFrame(fn: FrameHandler) {
		this.onFrameHandler = fn;
	}

	setOnStreamOpen(fn: StreamOpenHandler) {
		this.onStreamOpenHandler = fn;
	}

	openStream(protocol: string): ProtocolStream {
		const sid = this.nextStreamId++;
		const stream = new ProtocolStream(this, sid, protocol);
		this.streams.set(sid, stream);

		try {
			this.send({
				t: "STREAM_OPEN",
				payload: { sid, protocol },
			});
			return stream;
		} catch (error) {
			this.emit("error", error);
			this.streams.delete(sid);
			throw error;
		}
	}

	sendStreamData(sid: number, data: any) {
		try {
			this.send({
				t: "STREAM_DATA",
				payload: { sid, data },
			});
		} catch (error) {
			this.emit("error", error);
		}
	}

	sendStreamClose(sid: number, direction: Direction) {
		try {
			this.send({
				t: "STREAM_CLOSE",
				payload: { sid, direction },
			});
		} catch (error) {
			this.emit("error", error);
		}
	}

	private onData(chunk: Buffer) {
		try {
			this.partial = Buffer.concat([this.partial, chunk]);
			this.partial = decodeFrames(this.partial, (outer) => {
				this.dispatch(outer);
			});
		} catch (error) {
			this.emit("error", error);
		}
	}

	private dispatch(f: Packet | StreamPacket) {
		if (
			f.t === "STREAM_OPEN" ||
			f.t === "STREAM_DATA" ||
			f.t === "STREAM_CLOSE"
		) {
			try {
				return this.handleStreamPacket(f);
			} catch (error) {
				this.emit("error", error);
				return;
			}
		}

		try {
			this.onFrameHandler?.(f);
		} catch (err: any) {
			this.emit("error", err);
		}
	}

	private handleStreamPacket(pkt: StreamPacket) {
		switch (pkt.t) {
			case "STREAM_OPEN": {
				const { sid, protocol } = pkt.payload;
				if (this.streams.has(sid)) return;
				try {
					const stream = new ProtocolStream(this, sid, protocol);
					this.streams.set(sid, stream);

					this.onStreamOpenHandler(protocol, stream);
				} catch (error) {
					this.emit("error", error);
					this.streams.delete(sid);
				}
				break;
			}

			case "STREAM_DATA": {
				const { sid, data } = pkt.payload;
				const stream = this.streams.get(sid);

				if (!stream) {
					log(`[${this.remoteAddr}] STREAM_DATA for unknown sid=${sid}`);
					return;
				}
				try {
					stream.onData(data);
				} catch (error) {
					this.emit("error", error);
				}
				break;
			}

			case "STREAM_CLOSE": {
				const { sid } = pkt.payload;
				const stream = this.streams.get(sid);
				try {
					if (!stream) return;
					stream._onRemoteClose();
				} catch (error) {
					this.emit("error", error);
				}
				break;
			}
		}
	}

	public onClose() {
		for (const [sid, stream] of this.streams.entries()) {
			stream._onRemoteClose();
			this.streams.delete(sid);
		}

		if (!this.socket.destroyed) this.socket.end();
	}

	private sendRaw(frame: any) {
		try {
			if (!this.socket.writable) {
				throw new Error(
					`[${this.remoteAddr}] attempted to write to non-writable socket`,
				);
			}
			this.socket.write(encodeFrame(frame));
		} catch (error) {
			log(`[${this.remoteAddr}] failed to send frame: ${error?.message}`);
			this.emit("error", error);
		}
	}
}
