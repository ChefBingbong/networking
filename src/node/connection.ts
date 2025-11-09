// src/mux.ts
import net, { type AddressInfo } from "net";
import { type Frame, encodeFrame, decodeFrames } from "../protocol";
import EventEmitter from "events";
import type { RemoteInfo } from "dgram";
import type { NodeContext, PeerInfo } from "../transport";
import type { NetworkEventEmitter } from "./events";
import debug from "debug";

export type ConnectionHandler = (
	mc: MuxedConnection,
	f: Frame,
) => Promise<void>;
export type FrameHandler = (f: Frame) => void;
const log = debug("p2p:muxer");

export class MuxedConnection extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public socket: net.Socket;
	private target: PeerInfo;

	private ctx: PeerInfo;
	private partial: Buffer = Buffer.alloc(0) as Buffer;
	private onFrameHandler: FrameHandler | null = null;

	constructor(ctx: PeerInfo, sock: net.Socket) {
		super();
		this.ctx = ctx;
		this.target = {
			id: "unknown",
			host: sock.remoteAddress ?? "",
			port: sock.remotePort ?? 0,
		};
		this.socket = sock;
		sock.on("data", (chunk) => this.onData(chunk as Buffer));
		sock.on("close", () => this.onClose());

		// Lifecycle logs (mc itself will emit 'disconnect' on socket close)
		sock.once("close", (hadErr) => {
			log(
				`[${ctx.id}] inbound socket closed (${hadErr ? "error" : "clean"}) from ${this.target.host}:${this.target.port}`,
			);
		});
		sock.on("error", (err) => {
			log(
				`[${ctx.id}] inbound socket error from ${this.target.host}:${this.target.port}: ${err?.message || err}`,
			);
		});
	}

	setSocket(sock: net.Socket) {
		this.socket = sock;
		sock.on("data", (chunk) => this.onData(chunk as Buffer));
		sock.on("close", () => this.onClose());

		// Lifecycle logs (mc itself will emit 'disconnect' on socket close)
		sock.once("close", (hadErr) => {
			// log(
			// 	`[${ctx.id}] inbound socket closed (${hadErr ? "error" : "clean"}) from ${this.target.host}:${this.target.port}`,
			// );
		});
		sock.on("error", (err) => {
			// log(
			// 	`[${ctx.id}] inbound socket error from ${this.target.host}:${this.target.port}: ${err?.message || err}`,
			// );
		});
	}

	private sendRaw(frame: Frame) {
		this.socket.write(encodeFrame(frame));
	}

	send(frame: Frame) {
		this.sendRaw(frame);
	}

	setOnFrame(fn: FrameHandler) {
		this.onFrameHandler = fn;
	}

	private onData(chunk: Buffer) {
		this.partial = Buffer.concat([
			this.partial as Buffer,
			chunk as Buffer,
		]) as unknown as Buffer;

		this.partial = decodeFrames(this.partial, (outer) => {
			this.dispatch(outer);
		});
	}

	private dispatch(f: Frame) {
		this.onFrameHandler?.(f);
	}

	private onClose() {
		this.socket.end(() => {
			this.emit("disconnect", this.target);
		});
	}
}
