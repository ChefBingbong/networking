// core-handler.ts
import debug from "debug";
import type {
	ConnectionHandler,
	MuxedConnection,
} from "../connection/connection";
import { mkPong } from "../packet/packets";
import type { Packet } from "../packet/types";
import type { PeerNode } from "./node";

const log = debug("p2p:core");

export class CoreMessageHandler {
	private node: PeerNode;

	constructor(node: PeerNode) {
		this.node = node;
	}

	public handle: ConnectionHandler = async (
		conn: MuxedConnection,
		frame: Packet,
	) => {
		switch (frame.t) {
			case "PING": {
				const from = frame.payload?.from;
				const ts = frame.payload?.ts;
				log(`PING from ${from}`);
				// send pong with same timestamp
				conn.send(mkPong(this.node.address.toString(), ts));
				break;
			}

			case "PONG": {
				const from = frame.payload?.from;
				const ts = frame.payload?.ts;
				if (typeof ts === "number") {
					const rtt = Date.now() - ts;
					this.node.metrics.pingLatencies.push(rtt);
					log(`PONG from ${from}, RTT=${rtt}ms`);
				}
				break;
			}

			default:
				// ignore or handle other core messages
				break;
		}
	};
}
