// protocol/ProtocolStream.ts
import { EventEmitter } from "events";
import type { MuxedConnection } from "../node/connection";
import type { Packet } from "../packet/types";

/**
 * Simple protocol-level stream abstraction over a MuxedConnection.
 *
 * One ProtocolStream per connection in this design.
 * You can open multiple TCP connections if you need multiple protocols.
 */
export class ProtocolStream extends EventEmitter {
	public readonly protocol: string;
	private conn: MuxedConnection;
	private closed = false;

	constructor(protocol: string, conn: MuxedConnection) {
		super();
		this.protocol = protocol;
		this.conn = conn;
	}

	/**
	 * Send a protocol message. This wraps your data into a PROTOCOL_MSG frame.
	 */
	public send(data: any) {
		if (this.closed) return;
		const frame: Packet = {
			t: "PROTOCOL_MSG",
			payload: { data },
		} as any;
		this.conn.send(frame);
	}

	/**
	 * Close the writable side of the stream. Sends PROTOCOL_CLOSE.
	 */
	public close() {
		if (this.closed) return;
		this.closed = true;
		const frame: Packet = {
			t: "PROTOCOL_CLOSE",
			payload: {},
		} as any;
		this.conn.send(frame);
		this.emit("localCloseWrite");
	}

	/** Internal: invoked by ProtocolManager on incoming PROTOCOL_MSG */
	_onMessage(data: any) {
		// event shape: { data } to match your example
		this.emit("message", { data });
	}

	/** Internal: invoked by ProtocolManager on incoming PROTOCOL_CLOSE */
	_onRemoteCloseWrite() {
		this.emit("remoteCloseWrite");
	}

	/**
	 * Small ergonomics helper so you can use addEventListener like in your example.
	 */
	public addEventListener(
		event: "message" | "remoteCloseWrite" | "localCloseWrite",
		listener: (evt: any) => void,
	) {
		this.on(event, listener);
	}
}

export type ProtocolHandler = (stream: ProtocolStream) => void | Promise<void>;
