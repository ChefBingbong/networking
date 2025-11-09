import { Transport } from "./transport/transport";
import type { NodeContext } from "../transport";
import type { MuxedConnection } from "./connection";
import { wait, type Frame } from "../protocol";
import debug from "debug";
// import { sleep } from "bun";
import { EventEmitter } from "events";
import type { NetworkEventEmitter } from "./events";
import {
	computeSecp256k1PublicKey,
	generateSecp256k1KeyPair,
	generateSecp256k1KeyPrivPubPair,
	generateSecp256k1PrivateKey,
	type PeerKeyPair,
} from "../secp256k1/utils";
import { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import { Encrypter } from "./connection-encrypter";
import type { NodeInfo, PeerId } from "../session/nodeInfo";
import { safeError } from "../utils/safe";
import { isBoxedPrimitive } from "util/types";
import type { Packet, PacketBase } from "../packet/types";

const log = debug("p2p:node");

export type PeerInfo = {
	privateKey: Secp256k1PrivateKey;
	peerId: PeerId;
	nodeInfo: NodeInfo;
	host: string;
	port: number;
};
export type NodeOptions = { keyPair: Secp256k1PrivateKey };

export class PeerNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: NodeContext;
	private transport: Transport;
	private connections: Map<string, MuxedConnection> = new Map();
	private keyPair: PeerKeyPair;
	private peers: Map<string, PeerInfo> = new Map();

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
		if (connection) return connection;

		const peerId = this.peers.get(id);
		if (!peerId) throw new Error(`unknown peer ${id}`);

		const [error, mc] = await this.transport.dial(this.info, peerId);
		if (error) return safeError(error);

		this.connections.set(id, mc);
		mc.setOnFrame((f) => this.onFrame(mc, f));
		mc.socket.once("close", () => this.peers.delete(id));
		return mc;
	}

	private onFrame = async (mc: MuxedConnection, f: Packet | Frame) => {
		if (f.t === "PING") {
			mc.send({ t: "PONG", payload: { id: this.info.id } });
		} else if (f.t === "MSG") {
			console.log(`[${this.info.id}] <${f.from}>: ${f.payload?.text}`);
		} else if (f.t === "HELLO") {
			mc.send({ t: "PONG", payload: this.info });
		}
	};

	private onBootstrapFrame = (f: Frame) => {
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
