// src/protocol/protocol-stream.ts

import EventEmitter from "events";
import type { MuxedConnection } from "../node/connection";

export interface StreamMessageEvent {
	data: any;
}

/**
 * Logical full-duplex stream multiplexed over a MuxedConnection.
 *
 * Events:
 *  - "message": (evt: { data }) incoming app payload
 *  - "remoteCloseWrite": remote closed its side
 *  - "close": stream fully closed (both sides)
 *  - "error": (err: Error) stream-level error
 */
export class ProtocolStream extends EventEmitter {
	public readonly id: number;
	public readonly protocol: string;
	public readonly conn: MuxedConnection;
	private readonly initiator: boolean;

	private closedLocal = false;
	private closedRemote = false;

	constructor(
		conn: MuxedConnection,
		id: number,
		protocol: string,
		initiator: boolean,
	) {
		super();
		this.conn = conn;
		this.id = id;
		this.protocol = protocol;
		this.initiator = initiator;
	}

	/**
	 * Internal helper: safely emit a stream error without causing an
	 * unhandled 'error' event if nobody is listening.
	 */
	private _emitError(err: unknown) {
		const error =
			err instanceof Error ? err : new Error(String(err ?? "Unknown error"));

		if (this.listenerCount("error") > 0) {
			this.emit("error", error);
		} else {
			// Fallback so it doesn't silently disappear, but also
			// won't crash the process.
			// eslint-disable-next-line no-console
			console.error(
				`[ProtocolStream ${this.id} (${this.protocol})] unhandled error:`,
				error,
			);
		}
	}

	/**
	 * Send application data on this logical stream.
	 */
	send(data: any) {
		if (this.closedLocal) {
			const err = new Error("Cannot send on a closed stream");
			this._emitError(err);
			throw err;
		}

		try {
			this.conn._sendStreamData(this.id, data);
		} catch (err) {
			this._emitError(err);
			// Optionally mark our side closed on fatal send failure
			this.closedLocal = true;
			this._checkFullyClosed();
			throw err;
		}
	}

	/**
	 * Close our side of the stream.
	 * For now we treat it as fully closed (both directions) and clean up.
	 */
	close() {
		if (this.closedLocal) return;
		this.closedLocal = true;

		try {
			this.conn._sendStreamClose(this.id, "both");
		} catch (err) {
			// Closing shouldn't normally throw, but if it does,
			// surface it as a stream error.
			this._emitError(err);
		}

		this._checkFullyClosed();
	}

	/**
	 * Internal: called by MuxedConnection when STREAM_DATA arrives.
	 */
	_onData(data: any) {
		try {
			const evt: StreamMessageEvent = { data };
			this.emit("message", evt);
		} catch (err) {
			// If user message handler throws, treat it as a stream error
			this._emitError(err);
		}
	}

	/**
	 * Internal: called by MuxedConnection when remote sends STREAM_CLOSE.
	 */

	_onRemoteClose() {
		if (this.closedRemote) return;
		this.closedRemote = true;

		try {
			this.emit("remoteCloseWrite");
		} catch (err) {
			this._emitError(err);
		}

		this._checkFullyClosed();
	}

	private _checkFullyClosed() {
		if (this.closedLocal && this.closedRemote) {
			try {
				this.emit("close");
				this.conn._removeStream(this.id);
			} catch (err) {
				this._emitError(err);
			}
		}
	}

	/**
	 * Convenience for browser-y style:
	 *  stream.addEventListener("message", (evt) => ...)
	 */
	addEventListener(
		type: "message" | "remoteCloseWrite" | "close" | "error",
		listener: (evt: any) => void,
	) {
		this.on(type, listener);
	}
}
