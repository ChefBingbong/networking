import debug from "debug";
import EventEmitter from "events";
import type { MuxedConnection } from "./connection";

const log = debug("p2p:protocol-stream");

export interface StreamMessageEvent {
	data: any;
}

export class ProtocolStream extends EventEmitter {
	public readonly id: number;
	public readonly protocol: string;
	public readonly conn: MuxedConnection;

	private closedLocal = false;
	private closedRemote = false;

	constructor(conn: MuxedConnection, id: number, protocol: string) {
		super();
		this.conn = conn;
		this.id = id;
		this.protocol = protocol;

		this.addEventListener("error", (err) => {
			log(`stream err id=${this.id} protocol=${this.protocol}: ${err.message}`);
			this.conn.socket.destroy();
		});
	}

	private _emitError(error) {
		this.emit("error", error);
	}

	send(data: any) {
		if (this.closedLocal) {
			const err = new Error("Cannot send on a closed stream");
			this._emitError(err);
			throw err;
		}

		try {
			this.conn.sendStreamData(this.id, data);
		} catch (err) {
			this._emitError(err);
			this.closedLocal = true;
			this._checkFullyClosed();
			throw err;
		}
	}

	close() {
		if (this.closedLocal) return;
		this.closedLocal = true;

		try {
			this.conn.sendStreamClose(this.id, "both");
		} catch (err) {
			this._emitError(err);
		}

		this._checkFullyClosed();
	}

	onData(data: any) {
		try {
			const evt: StreamMessageEvent = { data };
			this.emit("message", evt);
		} catch (err) {
			this._emitError(err);
		}
	}

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
				this.conn.streams.delete(this.id);
			} catch (err) {
				this._emitError(err);
			}
		}
	}

	addEventListener(
		type: "message" | "remoteCloseWrite" | "close" | "error",
		listener: (evt: any) => void,
	) {
		this.on(type, listener);
	}
}
