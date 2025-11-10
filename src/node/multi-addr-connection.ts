// transport/multi-addr-connection.ts

import type { Debugger } from "debug";
import type { Duplex } from "it-stream-types";
import type { Socket } from "net";
import { Uint8ArrayList } from "uint8arraylist";

export interface AbortOptions {
	signal?: AbortSignal;
}

export interface MultiaddrConnectionTimeline {
	open: number;
	close?: number;
}

/**
 * Low-level raw connection, no TLS, no multiplexing.
 * This is what transports return and what the upgrader consumes.
 */
export interface MultiaddrConnection
	extends Duplex<AsyncGenerator<Uint8Array | Uint8ArrayList>> {
	close(options?: AbortOptions): Promise<void>;
	abort(err: Error): void;
	remoteAddr: string; // you can change to Multiaddr later
	timeline: MultiaddrConnectionTimeline;
	log: Debugger;

	// convenience: underlying socket
	socket: Socket;
}

type SourceType = AsyncGenerator<Uint8Array | Uint8ArrayList>;
type SinkType = (
	source: AsyncIterable<Uint8Array | Uint8ArrayList>,
) => Promise<void>;

export class SocketMultiaddrConnection implements MultiaddrConnection {
	public source: SourceType;
	public sink: SinkType;

	public readonly remoteAddr: string;
	public readonly timeline: MultiaddrConnectionTimeline;
	public readonly log: Debugger;
	public readonly socket: Socket;

	constructor(init: { socket: Socket; remoteAddr: string; log: Debugger }) {
		this.socket = init.socket;
		this.remoteAddr = init.remoteAddr;
		this.log = init.log;
		this.timeline = { open: Date.now() };

		this.source = this.readLoop();
		// IMPORTANT: bind `this` so writeLoop sees the right instance
		this.sink = this.writeLoop.bind(this);
	}

	private async *readLoop(): AsyncGenerator<Uint8Array> {
		const sock = this.socket;
		const queue: (Uint8Array | null)[] = [];
		let waiting: ((value: IteratorResult<Uint8Array | null>) => void) | null =
			null;

		const push = (item: Uint8Array | null) => {
			if (waiting) {
				const w = waiting;
				waiting = null;
				w({ value: item as any, done: item === null });
			} else {
				queue.push(item);
			}
		};

		const onData = (buf: Buffer) => push(new Uint8Array(buf));
		const onEnd = () => push(null);
		const onError = (err: Error) => {
			this.log("socket read error", err);
			push(null);
		};

		sock.on("data", onData);
		sock.once("end", onEnd);
		sock.once("error", onError);

		try {
			// basic async-queue
			// eslint-disable-next-line no-constant-condition
			while (true) {
				let item = queue.shift();
				if (item === undefined) {
					item = await new Promise<Uint8Array | null>((resolve) => {
						waiting = (res) => resolve(res.value as any);
					});
				}

				if (item === null) break;
				yield item;
			}
		} finally {
			sock.off("data", onData);
			sock.off("end", onEnd);
			sock.off("error", onError);
			this.timeline.close = Date.now();
		}
	}

	private async writeLoop(
		src: AsyncIterable<Uint8Array | Uint8ArrayList>,
	): Promise<void> {
		// inside here, `this.socket` will now be defined correctly
		for await (const chunk of src) {
			const buf = chunk instanceof Uint8ArrayList ? chunk.subarray() : chunk;
			if (!this.socket.writable) break;

			await new Promise<void>((resolve, reject) => {
				this.socket.write(buf, (err?: Error) => {
					if (err) reject(err);
					else resolve();
				});
			});
		}
	}

	async close(_opts?: AbortOptions): Promise<void> {
		this.socket.end();
	}

	abort(err: Error): void {
		this.socket.destroy(err);
	}

	[Symbol.asyncIterator](): AsyncGenerator<Uint8Array | Uint8ArrayList> {
		return this.source;
	}
}
