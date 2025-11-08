import { KeyPair } from "../crypto";
import { ECDH } from "crypto";
import { Transport } from "./transport";
import type { NodeContext } from "../transport";
import type { MuxedConnection } from "./connection";
import type { Frame } from "../protocol";
import { machine } from "os";
import debug from "debug";
import { sleep } from "bun";
import { EventEmitter } from "events";
import type { NetworkEventEmitter } from "./events";

const log = debug("p2p:node");

export type PeerInfo = { id: string; host: string; port: number };

export class PeerNode extends (EventEmitter as {
	new (): NetworkEventEmitter;
}) {
	public info: NodeContext;
	private keyPair: ECDH;
	private transport: Transport; // Assume Transport is defined elsewhere
	private serverConnMap: Map<string, MuxedConnection> = new Map();

	constructor(nodeInfo: PeerInfo) {
		super();
		this.info = {
			...nodeInfo,
			isBootstrap: false,
			peers: new Map<string, PeerInfo>(),
		};
		this.keyPair = KeyPair.generate().keyPair;
		this.transport = new Transport(this.info);
	}

	public async start() {
		this.transport.listen(this.info, (mc, remote) => {
			console.log(
				`[${this.info.id}] New connection from ${remote.remoteAddress}:${(remote.address() as any).port}`,
			);

			mc.setOnFrame((f) => this.onFrame(mc, f));
		});
		this.on("disconnect", this.handleDisconnect);

		console.log(`[${this.info.id}] Connecting to bootstrap node...`);
		const bootstrapStream = await this.transport.dial(this.info, {
			id: "bootstrap",
			host: "127.0.0.1",
			port: 4000,
		});

		bootstrapStream.setOnFrame(async (f) => {
			if (f.t === "PEER_LIST") {
				const payload = f.payload as { peers: PeerInfo[] };
				payload.peers.forEach((p) => {
					if (this.info.id === p.id) return;
					this.info.peers.set(p.id, p);
					log(`new peer ${p.id}`);
				});
			}
			if (f.t === "PEER_JOIN") {
				const payload = f.payload as PeerInfo;
				if (this.info.id === payload.id) return;
				this.info.peers.set(payload.id, payload);
				log(`${payload.id} joined`);
			}
			if (f.t === "PEER_LEAVE") {
				const payload = f.payload as PeerInfo;
				if (this.info.id === payload.id) return;
				this.info.peers.delete(payload.id);
				log(`${payload.id} left`);
			}
		});

		this.startHeartBeats(bootstrapStream);
	}

	private handleDisconnect(ctx: PeerInfo) {
		console.log(ctx, 'disconnected');
	}

	public async ensureConn(id: string): Promise<MuxedConnection> {
		if (this.serverConnMap.has(id)) return this.serverConnMap.get(id)!;
		const p = this.info.peers.get(id);
		if (!p) throw new Error(`unknown peer ${id}`);
		const mc = await this.transport.dial(this.info, p);
		mc.setOnFrame((f) => this.onFrame(mc, f));
		this.serverConnMap.set(id, mc);
		return mc;
	}

	private async onFrame(mc: MuxedConnection, f: Frame) {
		if (f.t === "PING") {
			console.log(`[${this.info.id}]`, f.payload);
			mc.send({ t: "PONG", payload: { id: this.info.id } });
		} else if (f.t === "MSG") {
			console.log(`[${this.info.id}] <${f.from}>: ${f.payload?.text}`);
		} else if (f.t === "HELLO") {
			console.log(`[${this.info.id}]`, f.payload);
			// const mc = await this.ensureConn(f.payload.id);
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
			await sleep(15000);

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
