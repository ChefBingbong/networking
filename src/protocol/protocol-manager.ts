// src/protocol/protocol-manager.ts

import type { ConnectionHandler, MuxedConnection } from "../node/connection";
import type { ProtocolStream } from "./protocol-stream";

export type ProtocolHandler = (stream: ProtocolStream) => void | Promise<void>;

export class ProtocolManager {
	// "/echo/1.0.0" -> handler
	private handlers = new Map<string, ProtocolHandler>();

	// track streams per connection, just for cleanup / introspection
	private connStreams = new Map<MuxedConnection, Set<ProtocolStream>>();

	/**
	 * Register a handler for a protocol id, e.g. "/echo/1.0.0"
	 */
	public register(protocol: string, handler: ProtocolHandler) {
		this.handlers.set(protocol, handler);
	}

	/**
	 * Called by PeerNode when a new stream is opened by the remote.
	 */
	public onIncomingStream(protocol: string, stream: ProtocolStream) {
		// this.trackStream(stream.conn, stream);

		const handler = this.handlers.get(protocol);
		if (!handler) {
			// no handler registered, politely close
			stream.close();
			return;
		}

		// fire handler (can be async, but we don't await here)
		void handler(stream);
	}

	/**
	 * Outgoing side: create a new stream for a given protocol on an existing connection.
	 */
	public async initOutgoing(
		conn: MuxedConnection,
		protocol: string,
	): Promise<ProtocolStream> {
		const stream = conn.openStream(protocol);
		this.trackStream(conn, stream);
		return stream;
	}

	/**
	 * Called by PeerNode when a connection is closed.
	 * We clean up any streams we were tracking for that connection.
	 */
	public onConnectionClosed(conn: MuxedConnection) {
		const set = this.connStreams.get(conn);
		if (!set) return;

		for (const stream of set) {
			// mark as closed from our side
			try {
				stream.close();
			} catch {
				// ignore
			}
		}
		this.connStreams.delete(conn);
	}

	/**
	 * Optional: currently we don't use frame-level protocol messages anymore,
	 * since protocols talk over streams. So this is effectively a no-op handler
	 * to satisfy MessageRouter's interface.
	 */
	public handle: ConnectionHandler = async (_conn, _frame) => {
		// Intentionally empty. If you later introduce frame-based protocol
		// messages, you can route them here.
	};

	// ----- internal helpers -----

	private trackStream(conn: MuxedConnection, stream: ProtocolStream) {
		let set = this.connStreams.get(conn);
		if (!set) {
			set = new Set<ProtocolStream>();
			this.connStreams.set(conn, set);
		}
		set.add(stream);

		// when the stream closes, untrack it
		stream.on("close", () => {
			const s = this.connStreams.get(conn);
			if (!s) return;
			s.delete(stream);
			if (s.size === 0) {
				this.connStreams.delete(conn);
			}
		});
	}
}
