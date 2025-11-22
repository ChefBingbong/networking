// udp-kademlia-transport.ts

import debug from "debug";
import dgram, { type RemoteInfo } from "dgram";
import type { Contact, KademliaTransport, KadRpc, NodeId } from "./types";

const log = debug("kad:transport");

/**
 * Internal wire format so we can correlate requests and responses.
 */
type WirePacket =
	| { kind: "req"; rpcId: string; msg: KadRpc }
	| { kind: "resp"; rpcId: string; msg: KadRpc };

type PendingRpc = {
	resolve: (rpc: KadRpc) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

export class UdpKademliaTransport implements KademliaTransport {
	private readonly socket: dgram.Socket;
	private readonly pending = new Map<string, PendingRpc>();

	constructor(
		private readonly localId: NodeId,
		private readonly bindHost: string,
		private readonly bindPort: number,

		private readonly onRpc: (
			msg: KadRpc,
			from: Contact,
		) => Promise<KadRpc | null>,
		private readonly rpcTimeoutMs: number,
	) {
		this.socket = dgram.createSocket("udp4");

		this.socket.on("message", (buf, rinfo) => {
			this.onMessage(buf, rinfo).catch((err) =>
				log("error in onMessage:", err),
			);
		});

		this.socket.on("error", (err) => {
			log("UDP socket error:", err);
		});

		this.socket.bind(this.bindPort, this.bindHost, () => {
			log(`UDP Kademlia listening on ${this.bindHost}:${this.bindPort}`);
		});
	}

	/**
	 * Core transport API used by KademliaNode.
	 */
	async sendRpc(to: Contact, rpc: KadRpc): Promise<KadRpc> {
		const rpcId = this.newRpcId();
		const packet: WirePacket = { kind: "req", rpcId, msg: rpc };
		const buf = Buffer.from(JSON.stringify(packet));

		return await new Promise<KadRpc>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(rpcId);
				reject(new Error("Kademlia RPC timeout"));
			}, this.rpcTimeoutMs);

			this.pending.set(rpcId, { resolve, reject, timer });

			this.socket.send(buf, to.port, to.host, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(rpcId);
					reject(err);
				}
			});
		});
	}

	/**
	 * Optional: clean shutdown.
	 */
	close() {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error("transport closed"));
			this.pending.delete(id);
		}
		this.socket.close();
	}

	// ---------- internal helpers ----------

	private newRpcId(): string {
		return (
			Math.random().toString(36).slice(2) +
			Date.now().toString(36) +
			":" +
			this.localId
		);
	}

	private async onMessage(buf: Buffer, rinfo: RemoteInfo) {
		let packet: WirePacket;
		try {
			packet = JSON.parse(buf.toString()) as WirePacket;
		} catch (err) {
			log("failed to decode packet:", err);
			return;
		}

		const { kind, rpcId, msg } = packet;

		if (kind === "resp") {
			const pending = this.pending.get(rpcId);
			if (!pending) {
				// stray / late response
				return;
			}
			this.pending.delete(rpcId);
			clearTimeout(pending.timer);
			pending.resolve(msg);
			return;
		}

		// kind === "req" → incoming RPC
		const from: Contact = {
			id: msg.from, // must be present on all KadRpc
			host: rinfo.address,
			port: rinfo.port,
		};

		let resp: KadRpc | null = null;
		try {
			resp = await this.onRpc(msg, from);
		} catch (err) {
			log("error in onRpc:", err);
		}

		if (!resp) {
			// one-way RPC (e.g. pure fire-and-forget STORE),
			// nothing to send back.
			return;
		}

		const respPacket: WirePacket = {
			kind: "resp",
			rpcId,
			msg: resp,
		};
		const outBuf = Buffer.from(JSON.stringify(respPacket));
		this.socket.send(outBuf, rinfo.port, rinfo.address, (err) => {
			if (err) log("failed to send response:", err);
		});
	}
}
