import type { MuxedConnection } from "./connection";
import type { ProtocolStream } from "./protocol-stream";
import type { ConnectionHandler } from "./types";

export type ProtocolHandler = (stream: ProtocolStream) => void | Promise<void>;

export class ProtocolManager {
	private handlers = new Map<string, ProtocolHandler>();
	private connStreams = new Map<MuxedConnection, Set<ProtocolStream>>();

	public register(protocol: string, handler: ProtocolHandler) {
		this.handlers.set(protocol, handler);
	}

	public onIncomingStream(protocol: string, stream: ProtocolStream) {
		const handler = this.handlers.get(protocol);
		if (!handler) {
			try {
				stream.close();
			} catch {}
			return;
		}

		void handler(stream);
	}

	public async initOutgoing(
		conn: MuxedConnection,
		protocol: string,
	): Promise<ProtocolStream> {
		const stream = conn.openStream(protocol);
		this.trackStream(conn, stream);
		return stream;
	}

	public onConnectionClosed(conn: MuxedConnection) {
		const set = this.connStreams.get(conn);
		if (!set) return;

		for (const stream of set) {
			try {
				stream.close();
			} catch {}
		}
		this.connStreams.delete(conn);
	}

	public handle: ConnectionHandler = async (_conn, _frame) => {};

	private trackStream(conn: MuxedConnection, stream: ProtocolStream) {
		let set = this.connStreams.get(conn);
		if (!set) {
			set = new Set<ProtocolStream>();
			this.connStreams.set(conn, set);
		}
		set.add(stream);

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
