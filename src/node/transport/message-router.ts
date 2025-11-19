import type {
	ConnectionHandler,
	MuxedConnection,
} from "../../connection/connection";
import type { Packet } from "../../packet/types";

export class MessageRouter {
	private handlers: ConnectionHandler[] = [];

	register(handler: ConnectionHandler) {
		this.handlers.push(handler);
	}

	public handle: ConnectionHandler = async (
		conn: MuxedConnection,
		frame: Packet,
	) => {
		for (const h of this.handlers) {
			await h(conn, frame);
		}
	};
}
