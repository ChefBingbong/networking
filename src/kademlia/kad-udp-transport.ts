// src/kademlia/kad-udp-transport.ts

import debug from "debug";
import dgram, { type RemoteInfo } from "dgram";

const log = debug("p2p:kad:udp");

export interface KadUdpMessage {
	// we'll just send the KadMessage object as JSON, plus optional rpcId
	[key: string]: any;
}

export type KadUdpHandler = (
	msg: KadUdpMessage,
	rinfo: RemoteInfo,
) => void | Promise<void>;

export class KadUdpTransport {
	private socket: dgram.Socket;
	private host: string;
	private port: number;
	private handler: KadUdpHandler;

	constructor(host: string, port: number, handler: KadUdpHandler) {
		this.host = host;
		this.port = port;
		this.handler = handler;

		this.socket = dgram.createSocket("udp4");
		this.socket.on("message", (buf, rinfo) => this.onMessage(buf, rinfo));
		this.socket.on("error", (err) => {
			log(`UDP error: ${err?.message || err}`);
		});
		this.socket.bind(this.port, this.host, () => {
			log(`Kad UDP bound on ${this.host}:${this.port}`);
		});
	}

	private async onMessage(buf: Buffer, rinfo: RemoteInfo) {
		try {
			const text = buf.toString("utf8");
			const msg = JSON.parse(text) as KadUdpMessage;
			await this.handler(msg, rinfo);
		} catch (err) {
			log("Failed to parse UDP message:", err);
		}
	}

	public send(msg: KadUdpMessage, host: string, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const data = Buffer.from(JSON.stringify(msg), "utf8");
			this.socket.send(data, port, host, (err) => {
				if (err) {
					log(`UDP send error to ${host}:${port}:`, err);
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	public close() {
		this.socket.close();
	}
}
