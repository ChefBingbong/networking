// src/protocol/protocol-stream.ts

import EventEmitter from "events";
// adjust this import path to where your MuxedConnection is exported
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
	 * Send application data on this logical stream.
	 */
	send(data: any) {
		if (this.closedLocal) {
			throw new Error("Cannot send on a closed stream");
		}
		this.conn._sendStreamData(this.id, data);
	}

	/**
	 * Close our side of the stream.
	 * For now we treat it as fully closed (both directions) and clean up.
	 */
	close() {
		if (this.closedLocal) return;
		this.closedLocal = true;
		this.conn._sendStreamClose(this.id, "both");
		this._checkFullyClosed();
	}

	/**
	 * Internal: called by MuxedConnection when STREAM_DATA arrives.
	 */
	_onData(data: any) {
		const evt: StreamMessageEvent = { data };
		this.emit("message", evt);
	}

	/**
	 * Internal: called by MuxedConnection when remote sends STREAM_CLOSE.
	 */
	_onRemoteClose() {
		if (this.closedRemote) return;
		this.closedRemote = true;
		this.emit("remoteCloseWrite");
		this._checkFullyClosed();
	}

	private _checkFullyClosed() {
		if (this.closedLocal && this.closedRemote) {
			this.emit("close");
			this.conn._removeStream(this.id);
		}
	}

	/**
	 * Convenience for browser-y style:
	 *  stream.addEventListener("message", (evt) => ...)
	 */
	addEventListener(
		type: "message" | "remoteCloseWrite" | "close",
		listener: (evt: any) => void,
	) {
		this.on(type, listener);
	}
}
