// protocol/ProtocolManager.ts
import type { ConnectionHandler, MuxedConnection } from "../node/connection";
import type { Packet } from "../packet/types";
import { type ProtocolHandler, ProtocolStream } from "./protocol-stream";

/**
 * ProtocolManager:
 *  - maps protocol strings ("/ping/1.0.0") to handlers
 *  - manages a single ProtocolStream per connection
 *  - routes PROTOCOL_* frames to the appropriate stream
 */
export class ProtocolManager {
	private handlers = new Map<string, ProtocolHandler>();
	private streams = new Map<MuxedConnection, ProtocolStream>();

	/**
	 * Register a handler for a protocol, e.g. "/echo/1.0.0".
	 */
	public register(protocol: string, handler: ProtocolHandler) {
		this.handlers.set(protocol, handler);
	}

	/**
	 * Called when a connection is closed (to clean up internal state).
	 */
	public onConnectionClosed(conn: MuxedConnection) {
		this.streams.delete(conn);
	}

	/**
	 * ConnectionHandler for your MessageRouter.
	 *
	 * This inspects PROTOCOL_* packets and converts them into events on a ProtocolStream.
	 */
	public handle: ConnectionHandler = async (
		conn: MuxedConnection,
		frame: Packet,
	) => {
		switch (frame.t) {
			case "PROTOCOL_SELECT": {
				const protocol = frame.payload?.protocol as string | undefined;
				if (!protocol) return;

				// If we already have a stream, ignore duplicate selects.
				if (this.streams.has(conn)) return;

				const handler = this.handlers.get(protocol);
				if (!handler) {
					// No handler for this protocol; you might want to close the conn here.
					// conn.onClose();
					return;
				}

				const stream = new ProtocolStream(protocol, conn);
				this.streams.set(conn, stream);

				// Call the registered handler for inbound protocol selection
				await handler(stream);
				return;
			}

			case "PROTOCOL_MSG": {
				const stream = this.streams.get(conn);
				if (!stream) return;
				const data = frame.payload?.data;
				stream._onMessage(data);
				return;
			}

			case "PROTOCOL_CLOSE": {
				const stream = this.streams.get(conn);
				if (!stream) return;
				stream._onRemoteCloseWrite();
				// The remote closed its writable side; you may keep the conn open or fully close.
				this.streams.delete(conn);
				return;
			}

			default:
				// Not a protocol frame, ignore.
				return;
		}
	};

	/**
	 * Initialize an outgoing protocol stream.
	 *
	 * - Registers the stream for this connection
	 * - Sends PROTOCOL_SELECT with the protocol identifier
	 * - Optionally calls the handler on the local side too (symmetric behavior)
	 */
	public async initOutgoing(
		conn: MuxedConnection,
		protocol: string,
		callLocalHandler = false,
	): Promise<ProtocolStream> {
		const stream = new ProtocolStream(protocol, conn);
		this.streams.set(conn, stream);

		const selectFrame: Packet = {
			t: "PROTOCOL_SELECT",
			payload: { protocol },
		} as any;

		conn.send(selectFrame);

		if (callLocalHandler) {
			const handler = this.handlers.get(protocol);
			if (handler) {
				await handler(stream);
			}
		}

		return stream;
	}
}
