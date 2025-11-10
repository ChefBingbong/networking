// src/mux.ts

import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import EventEmitter from "events";
import net from "net";
import { decodeFrames, encodeFrame } from "../packet/encode";
import type { Packet } from "../packet/types";
import type { NetworkEventEmitter } from "./events";

export type ConnectionHandler = (
	mc: MuxedConnection,
	f: Packet,
) => Promise<void>;
export type FrameHandler = (f: Packet) => void;
const log = debug("p2p:muxer");

export class MuxedConnection extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public socket: net.Socket;
	private partial: Buffer = Buffer.alloc(0) as Buffer;
	private onFrameHandler: FrameHandler | null = null;

	constructor(addr: Multiaddr | undefined, sock: net.Socket) {
		super();
		this.socket = sock;
		sock.on("data", (chunk) => this.onData(chunk as Buffer));
		sock.on("close", () => this.onClose());

		sock.once("close", (hadErr) => {
			log(`[${addr}] inbound socket closed (${hadErr ? "error" : "clean"})`);
		});
		sock.on("error", (err) => {
			log(`[${addr}] inbound socket error: ${err?.message || err}`);
		});
	}

	private sendRaw(frame: any) {
		this.socket.write(encodeFrame(frame));
	}

	send(frame: any) {
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

	private dispatch(f: Packet) {
		this.onFrameHandler?.(f);
	}

	public onClose() {
		this.socket.end();
	}
}
