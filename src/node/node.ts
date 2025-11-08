import { Transport } from "./transport";
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

const log = debug("p2p:node");

export type PeerInfo = { id: string; host: string; port: number };
export type NodeOptions = { keyPair: Secp256k1PrivateKey };

export class PeerNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: NodeContext;
	private transport: Transport;
	private serverConnMap: Map<string, MuxedConnection> = new Map();
	private keyPair: PeerKeyPair;
	constructor(nodeInfo: PeerInfo, opts: NodeOptions) {
		super();
		this.info = {
			...nodeInfo,
			isBootstrap: false,
			peers: new Map<string, PeerInfo>(),
		};
		this.keyPair = generateSecp256k1KeyPrivPubPair();
		this.transport = new Transport(this.info, this.keyPair);
	}

	public async start() {
		// Incoming TLS+Mux is handled by Transport.listen
		this.transport.listen(this.info, (mc, tlsSock) => {
			log(
				`[${this.info.id}] inbound TLS conn from ${tlsSock.remoteAddress}:${tlsSock.remotePort}`,
			);
			mc.setOnFrame((f) => this.onFrame(mc, f));
		});

		// connect to bootstrap (Transport.dial does TLS+verify for us)
		log(`[${this.info.id}] connecting to bootstrap...`);
        try {
		const bootstrap = await this.transport.dial(this.info, {
			id: "bootstrap",
			host: "127.0.0.1",
			port: 4000,
		});


		bootstrap.setOnFrame(async (f) => {
			if (f.t === "PEER_LIST") {
				const payload = f.payload as { peers: PeerInfo[] };
				payload.peers.forEach((p) => {
					if (this.info.id === p.id) return;
					this.info.peers.set(p.id, p);
					log(`new peer ${p.id}`);
				});
			} else if (f.t === "PEER_JOIN") {
				const p = f.payload as PeerInfo;
				if (this.info.id !== p.id) {
					this.info.peers.set(p.id, p);
					log(`${p.id} joined`);
				}
			} else if (f.t === "PEER_LEAVE") {
				const p = f.payload as PeerInfo;
				if (this.info.id !== p.id) {
					this.info.peers.delete(p.id);
					log(`${p.id} left`);
				}
			}
		});

		this.startHeartBeats(bootstrap);
            } catch (err) {
        log("Failed to connect to bootstrap:", err);
        return;
    }
	}

	public async ensureConn(id: string): Promise<MuxedConnection> {
		console.log(this.serverConnMap.get(id)!);
		if (this.serverConnMap.has(id)) return this.serverConnMap.get(id)!;
		console.log("hhhhhhhh");
		const p = this.info.peers.get(id);
		if (!p) throw new Error(`unknown peer ${id}`);

		const mc = await this.transport.dial(this.info, p);
		mc.setOnFrame((f) => this.onFrame(mc, f));
		this.serverConnMap.set(id, mc);
		return mc;
	}

	private async onFrame(mc: MuxedConnection, f: Frame) {
		console.log(f);
		if (f.t === "PING") {
			mc.send({ t: "PONG", payload: { id: this.info.id } });
		} else if (f.t === "MSG") {
			console.log(`[${this.info.id}] <${f.from}>: ${f.payload?.text}`);
		} else if (f.t === "HELLO") {
			mc.send({ t: "PONG", payload: this.info });
		}
	}

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
