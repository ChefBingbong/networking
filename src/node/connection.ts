// src/connection/types.ts

import type {
	Direction,
	NewStreamOptions,
	Stream,
} from "@libp2p/interface-connection";
import type { PeerId } from "@libp2p/interface-peer-id";
import type { Debugger as Logger } from "debug";
import { EventEmitter } from "events";
import type { PeerRemote } from "../session/nodeInfo";
import type { MultiaddrConnection } from "./multi-addr-connection";

// src/connection/single-stream-muxer.ts

export class SingleStreamMuxer extends EventEmitter implements StreamMuxer {
	public protocol = "single-stream";
	public streams: Stream[] = [];

	private readonly maConn: MultiaddrConnection;
	private created = false;

	constructor(maConn: MultiaddrConnection) {
		super();
		this.maConn = maConn;
	}

	async newStream(
		protocols: string[],
		_options?: NewStreamOptions,
	): Promise<Stream> {
		// For now: only one stream, reused
		// if (this.created && this.streams[0]) {
		// 	return this.streams[0];
		// }

		const protocol = protocols[0];

		// Wrap the MultiaddrConnection as a libp2p Stream
		const stream: Stream = {
			// duplex
			source: this.maConn.source,
			sink: this.maConn.sink,
			// metadata
			protocol,
			// lifecycle
			async close(options?: any) {
				await this.maConn.close(options);
			},
			reset: () => {
				this.maConn.abort(new Error("stream reset"));
			},
			// eslint-disable-next-line @typescript-eslint/no-empty-function
			[Symbol.asyncIterator]: function (this: Stream) {
				return this.source[Symbol.asyncIterator]();
			},
		} as any;

		this.created = true;
		this.streams = [stream];
		this.emit("stream:open", stream);
		return stream;
	}

	async close(): Promise<void> {
		if (this.streams[0]) {
			await this.streams[0].close();
		} else {
			await this.maConn.close();
		}
		this.emit("close");
	}

	abort(err: Error): void {
		this.maConn.abort(err);
		this.emit("close", err);
	}
}

// src/connection/connection.ts

export class MuxedConnection extends EventEmitter implements Connection {
	public id: string;
	public remoteAddr: string;
	public remotePeer: PeerRemote;
	public streams: Stream[] = [];
	public direction: Direction;
	public multiplexer?: string;
	public encryption?: string;
	public status: string = "open";
	public log: Logger;

	private readonly maConn: MultiaddrConnection;
	private readonly muxer: StreamMuxer;

	constructor(init: {
		id: string;
		remoteAddr: string;
		remotePeer: PeerRemote;
		direction: Direction;
		maConn: MultiaddrConnection;
		muxer: StreamMuxer;
		multiplexer?: string;
		encryption?: string;
		log: Logger;
	}) {
		super();
		this.id = init.id;
		this.remoteAddr = init.remoteAddr;
		this.remotePeer = init.remotePeer;
		this.direction = init.direction;
		this.maConn = init.maConn;
		this.muxer = new SingleStreamMuxer(this.maConn);
		this.multiplexer = init.multiplexer ?? init.muxer.protocol;
		this.encryption = init.encryption;
		this.log = init.log;

		this.streams = this.muxer.streams;

		// Track streams created/closed by the muxer and re-expose events
		this.muxer.on("stream:open", (s: Stream) => {
			this.streams = this.muxer.streams;
			this.emit("stream:open", s);
		});

		this.muxer.on("stream:close", (s: Stream) => {
			this.streams = this.muxer.streams;
			this.emit("stream:close", s);
		});
	}

	async newStream(
		protocols: string | string[],
		options?: NewStreamOptions,
	): Promise<Stream> {
		const protos = Array.isArray(protocols) ? protocols : [protocols];
		const stream = await this.muxer.newStream(["tcp"], options);
		this.streams = this.muxer.streams;
		return stream;
	}

	async close(options?: any): Promise<void> {
		if (this.status === "closed" || this.status === "closing") return;

		this.status = "closing";
		this.log("closing connection %s", this.id);

		await this.muxer.close();
		await this.maConn.close(options);

		this.status = "closed";
		this.emit("close");
	}

	abort(err: Error): void {
		if (this.status === "closed" || this.status === "closing") return;

		this.status = "closing";
		this.log("aborting connection %s: %s", this.id, err.message);

		try {
			this.muxer.abort(err);
		} catch {}

		this.maConn.abort(err);
		this.status = "closed";
		this.emit("close", err);
	}
}

export interface Connection {
	id: string;
	remoteAddr: string;
	remotePeer: PeerId;
	streams: Stream[];
	direction: Direction;
	multiplexer?: string;
	encryption?: string;
	status: string;
	newStream(
		protocols: string | string[],
		options?: NewStreamOptions,
	): Promise<Stream>;
	close(options?: any): Promise<void>;
	abort(err: Error): void;
	log: Logger;
}

/**
 * Minimal muxer interface we’ll plug into the Connection.
 * Later you can swap this with mplex/yamux as long as it respects this shape.
 */
export interface StreamMuxer extends EventEmitter {
	protocol: string;
	streams: Stream[];

	newStream(protocols: string[], options?: NewStreamOptions): Promise<Stream>;

	close(): Promise<void>;
	abort(err: Error): void;
}
