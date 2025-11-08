import { KeyPair } from "../crypto";
import { ECDH } from "crypto";
import { Transport } from "./transport";
import type { NodeContext } from "../transport";
import type { MuxedConnection } from "./connection";
import { wait, type Frame } from "../protocol";
import type { NodeOptions, PeerInfo } from "./node";
import debug from "debug";
import {
	computeSecp256k1PublicKey,
	generateSecp256k1KeyPrivPubPair,
	generateSecp256k1PrivateKey,
	type PeerKeyPair,
} from "../secp256k1/utils";
import {
	Secp256k1PrivateKey,
	Secp256k1PublicKey,
} from "../secp256k1/secp256k1";
import { Encrypter } from "./connection-encrypter";
import EventEmitter from "events";
import type { NetworkEventEmitter } from "./events";

const log = debug("p2p:node");

export class BootStrapNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: NodeContext;
	private transport: Transport; // Assume Transport is defined elsewhere
	private lastSeen: Map<string, number> = new Map();
	private connections: Map<string, MuxedConnection> = new Map();

	private keyPair: PeerKeyPair;
	constructor(nodeInfo: PeerInfo, opts?: NodeOptions) {
		super();
		this.info = {
			...nodeInfo,
			isBootstrap: false,
			peers: new Map<string, PeerInfo>(),
		};
		this.keyPair = generateSecp256k1KeyPrivPubPair();
		this.transport = new Transport(this.info, this.keyPair);
	}

	public start() {
		this.transport.listen(this.info, async (mc, remote) => {
			log(
				`[${this.info.id}] New connection from ${remote.remoteAddress}:${remote.localPort}`,
			);
			// Handle the new connection (mc)
			// await this.transport.performUpgrade(this.info, mc, false)
			mc.setOnFrame((f) => this.onFrame(mc, f));
		});

		this.monitorStaleConnections();
		// attempt to connect to known bootstrap nodes or peers here
	}

	private onFrame(mc: MuxedConnection, f: Frame) {
		console.log(f);
		if (f.t === "PEER_JOIN") {
			const { id, host, port } = f.payload as PeerInfo;
			this.info.peers.set(id, { id, host, port });
			this.connections.set(id, mc);
			this.lastSeen.set(id, Date.now());
			log(`[bootstrap] ${id} joined (${host}:${port})`);

			this.send(mc, {
				t: "PEER_LIST",
				payload: { peers: [...this.info.peers.values()] },
			});
			this.broadcast({ t: "PEER_JOIN", payload: f.payload });
		} else if (f.t === "HEARTBEAT") {
			const payload = f.payload as PeerInfo;
			this.lastSeen.set(payload.id, Date.now());
			log(`[${this.info.id}] ${f.from}: ${Date.now()}`);
		}
	}

	private async monitorStaleConnections() {
		while (true) {
			await wait(30000);
			const now = Date.now();

			this.lastSeen.entries().forEach(([k, v]) => {
				console.log(now, v);
				if (now > v + 30000) {
					const mc = this.connections.get(k)!;
					const ctx = this.info.peers.get(k)!;
					this.broadcast({ t: "PEER_LEAVE", payload: ctx });
					log(`[bootstrap] connection to ${ctx.id} terminated`);
					this.connections.delete(k);
					this.info.peers.delete(k);
					this.lastSeen.delete(k);
					mc?.socket.destroy();
				}
			});
		}
	}

	public broadcast(frame: Frame) {
		console.log(this.connections.keys().toArray());
		this.connections.values().forEach((mc) => {
			this.send(mc, frame);
		});
	}
	private send(mc: MuxedConnection, frame: Frame) {
		mc.send(frame);
	}
}
