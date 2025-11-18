// src/protocol/protocol-stream.ts

import debug from "debug";
import EventEmitter from "events";
import type { MuxedConnection } from "../node/connection";

const log = debug("p2p:protocol-stream");

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

		log(
			`created ProtocolStream id=${this.id} protocol=${this.protocol} initiator=${this.initiator}`,
		);
	}

	/**
	 * Internal helper: safely emit a stream error without causing an
	 * unhandled 'error' event if nobody is listening.
	 */
	private _emitError(err: unknown) {
		const error =
			err instanceof Error ? err : new Error(String(err ?? "Unknown error"));

		log(
			`stream error id=${this.id} protocol=${this.protocol}: ${error.message}`,
			error,
		);

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
			log(
				`attempted send on closed stream id=${this.id} protocol=${this.protocol}`,
			);
			this._emitError(err);
			throw err;
		}

		try {
			log(
				`sending data on stream id=${this.id} protocol=${this.protocol}, closedRemote=${this.closedRemote}`,
			);
			this.conn._sendStreamData(this.id, data);
		} catch (err) {
			console.log(
				`_sendStreamData threw for stream id=${this.id} protocol=${this.protocol}`,
				err,
			);
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
		if (this.closedLocal) {
			log(
				`close() called but stream already closed locally id=${this.id} protocol=${this.protocol}`,
			);
			return;
		}
		this.closedLocal = true;
		log(`closing local side of stream id=${this.id} protocol=${this.protocol}`);

		try {
			this.conn._sendStreamClose(this.id, "both");
		} catch (err) {
			// Closing shouldn't normally throw, but if it does,
			// surface it as a stream error.
			console.log(
				`_sendStreamClose threw for stream id=${this.id} protocol=${this.protocol}`,
				err,
			);
			this._emitError(err);
		}

		this._checkFullyClosed();
	}

	/**
	 * Internal: called by MuxedConnection when STREAM_DATA arrives.
	 */
	_onData(data: any) {
		try {
			log(
				`received data on stream id=${this.id} protocol=${this.protocol}, closedLocal=${this.closedLocal} closedRemote=${this.closedRemote}`,
			);
			const evt: StreamMessageEvent = { data };
			this.emit("message", evt);
		} catch (err) {
			// If user message handler throws, treat it as a stream error
			console.log(
				`message handler threw for stream id=${this.id} protocol=${this.protocol}`,
				err,
			);
			this._emitError(err);
		}
	}

	/**
	 * Internal: called by MuxedConnection when remote sends STREAM_CLOSE.
	 */
	_onRemoteClose() {
		if (this.closedRemote) {
			log(
				`_onRemoteClose called but stream already closedRemote=true id=${this.id} protocol=${this.protocol}`,
			);
			return;
		}
		this.closedRemote = true;

		log(
			`remote closed its side of stream id=${this.id} protocol=${this.protocol}`,
		);

		try {
			this.emit("remoteCloseWrite");
		} catch (err) {
			console.log(
				`remoteCloseWrite listener threw for stream id=${this.id} protocol=${this.protocol}`,
				err,
			);
			this._emitError(err);
		}

		this._checkFullyClosed();
	}

	private _checkFullyClosed() {
		if (this.closedLocal && this.closedRemote) {
			log(
				`stream fully closed (local+remote) id=${this.id} protocol=${this.protocol}, removing from mux`,
			);
			try {
				this.emit("close");
				this.conn._removeStream(this.id);
			} catch (err) {
				console.log(
					`error during final close/cleanup for stream id=${this.id} protocol=${this.protocol}`,
					err,
				);
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
