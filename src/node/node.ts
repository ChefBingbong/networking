import debug from "debug";
import { EventEmitter } from "events";
import { wait } from "../packet/encode";
import type { Packet } from "../packet/types";
import {
	generateSecp256k1KeyPrivPubPair,
	type PeerKeyPair,
} from "../secp256k1/utils";
import type { PeerInfo, PeerRemote } from "../session/nodeInfo";
import { safeError, safeResult } from "../utils/safe";
import type { MuxedConnection } from "./connection";
import type { NetworkEventEmitter } from "./events";
import { Transport } from "./transport/transport";

const log = debug("p2p:node");

export class PeerNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: PeerInfo;
	private transport: Transport;
	private connections: Map<string, MuxedConnection> = new Map();
	private keyPair: PeerKeyPair;
	public peers: Map<string, PeerRemote> = new Map();

	constructor(nodeInfo: PeerInfo) {
		super();
		this.info = nodeInfo;
		this.keyPair = generateSecp256k1KeyPrivPubPair();
		this.transport = new Transport(this.keyPair);
	}

	public async start() {
		const listener = this.transport.createListener(this.info, this.onFrame);
		const listenError = await listener.listen(this.info);

		if (listenError) {
			log("Failed to start listener:", listenError);
			return;
		}
		const [error, bootstrap] = await this.transport.dial(this.info, {
			id: "bootstrap",
			host: "127.0.0.1",
			port: 4000,
		});
		if (error) {
			log("Failed to dial bootstrap:", error);
			return;
		}

		bootstrap.setOnFrame(async (f) => this.onBootstrapFrame(f));
		this.startHeartBeats(bootstrap);
	}

	public async ensureConn(id: string) {
		const connection = this.connections.get(id);
		if (connection) return safeResult(connection);

		const peerId = this.peers.get(id);
		if (!peerId) return safeResult(undefined);

		const [error, mc] = await this.transport.dial(this.info, peerId);
		if (error) return safeError(error);

		this.connections.set(id, mc);
		mc.setOnFrame((f) => this.onFrame(mc, f));
		mc.socket.once("close", () => this.peers.delete(id));

		return safeResult(mc);
	}

	private onFrame = async (mc: MuxedConnection, f: Packet) => {
		if (f.t === "PING") {
			mc.send({ t: "PONG", payload: { id: this.info.id } });
		} else if (f.t === "MSG") {
			console.log(`[${this.info.id}] <${f.from}>: ${f.payload?.text}`);
		} else if (f.t === "HELLO") {
			mc.send({ t: "PONG", payload: this.info });
		}
	};

	private onBootstrapFrame = (f: Packet) => {
		console.log(f);
		if (f.t === "PEER_LIST") {
			const payload = f.payload as { peers: PeerInfo[] };
			payload.peers.forEach((p) => {
				if (this.info.id === p.id) return;
				this.peers.set(p.id, p);
				log(`new peer ${p.id}`);
			});
		} else if (f.t === "PEER_JOIN") {
			const p = f.payload as PeerInfo;
			if (this.info.id !== p.id) {
				this.peers.set(p.id, p);
				log(`${p.id} joined`);
			}
		} else if (f.t === "PEER_LEAVE") {
			const p = f.payload as PeerInfo;
			if (this.info.id !== p.id) {
				this.peers.delete(p.id);
				log(`${p.id} left`);
			}
		}
	};

	private async startHeartBeats(bs: MuxedConnection) {
		bs.send({
			t: "PEER_JOIN",
			from: this.info.id,
			to: "HOST",
			payload: { id: this.info.id, host: this.info.host, port: this.info.port },
		});

		while (true) {
			await wait(15_000);
			bs.send({
				t: "HEARTBEAT",
				from: this.info.id,
				to: "HOST",
				payload: {
					id: this.info.id,
					host: this.info.host,
					port: this.info.port,
				},
			});
		}
	}
}
