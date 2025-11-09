// src/node/bootstrapNode.ts
import debug from "debug";
import EventEmitter from "events";
import type { NetworkEventEmitter } from "./events";
import type { NodeContext } from "../transport";
import type { MuxedConnection } from "./connection";
import { Transport } from "./transport/transport";

import { mkPeerList, mkPeerJoin, mkPeerLeave } from "../packet/packets";
import { startTicker } from "../packet/encode";
import {
	generateSecp256k1KeyPrivPubPair,
	type PeerKeyPair,
} from "../secp256k1/utils";
import { PacketType, type Packet, type PeerInfo } from "../packet/types";
import type { Frame } from "../protocol";

const log = debug("p2p:bootstrap");

export class BootStrapNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: NodeContext;
	private transport: Transport;
	private connections = new Map<string, MuxedConnection>();
	private lastSeen = new Map<string, number>();
	private peers = new Map<string, PeerInfo>();
	private keyPair: PeerKeyPair;

	constructor(nodeInfo: PeerInfo) {
		super();
		this.info = nodeInfo;
		this.keyPair = generateSecp256k1KeyPrivPubPair();
		this.transport = new Transport(this.keyPair);
	}

	public async start() {
		const listener = this.transport.createListener(
			this.info,
			this.onInboundFrame,
		);
		const listenErr = await listener.listen(this.info);
		if (listenErr) return log("listen failed:", listenErr);

		const stopEvict = startTicker(() => this.evictStale(75_000), 15_000);
		listener.server?.on("close", stopEvict);
	}

	private onInboundFrame = async (mc: MuxedConnection, pkt: Packet | Frame) => {
		switch (pkt.t) {
			case PacketType.PEER_JOIN: {
				const p = pkt.payload;
				this.peers.set(p.id, p);
				this.connections.set(p.id, mc);
				this.lastSeen.set(p.id, Date.now());

				mc.send(mkPeerList([...this.peers.values()]));
				this.broadcast(mkPeerJoin(p), p.id);

				log(`[bootstrap] ${p.id} joined (${p.host}:${p.port})`);
				break;
			}
			case PacketType.HEARTBEAT: {
				const { id } = pkt.payload;
				this.lastSeen.set(id, Date.now());
				log(`[bootstrap] heartbeat from ${id}`);
				break;
			}
			default:
				break;
		}
	};

	private evictStale(maxAgeMs: number) {
		const now = Date.now();
		for (const [id, last] of this.lastSeen) {
			if (now - last > maxAgeMs) {
				const conn = this.connections.get(id);
				const p = this.peers.get(id);
				if (p) this.broadcast(mkPeerLeave(id), id);
				conn?.socket.destroy();
				this.connections.delete(id);
				this.peers.delete(id);
				this.lastSeen.delete(id);
				log(`[bootstrap] evicted ${id} (missed heartbeats)`);
			}
		}
	}

	private broadcast(pkt: Packet, excludeId?: string) {
		for (const [id, mc] of this.connections) {
			if (id === excludeId) continue;
			try {
				mc.send(pkt);
			} catch {}
		}
	}
}
