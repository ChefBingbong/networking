// transport/transport-listener.ts

import debug from "debug";
import net, { type AddressInfo, type Server, type Socket } from "net";
import type { PeerInfo } from "../../session/nodeInfo";
import { safeError, safeTry } from "../../utils/safe";
import type { Connection } from "../connection";
import { SocketMultiaddrConnection } from "../multi-addr-connection";
import type { Upgrader } from "../upgrader";
export type ConnectionHandler = (conn: Connection) => void | Promise<void>;

const log = debug("p2p:transport");

export class TransportListener {
	public server: Server;
	peerContext: PeerInfo;
	private addr: string = "unknown";
	private connectionHandler: ConnectionHandler;
	private upgrader: Upgrader;

	constructor(
		ctx: PeerInfo,
		upgrader: Upgrader,
		connectionHandler: ConnectionHandler,
	) {
		this.peerContext = ctx;
		this.upgrader = upgrader;
		this.connectionHandler = connectionHandler;
		this.server = net.createServer(this.onSocket);
		this.server
			.on("listening", () => {
				const address = this.server.address();

				if (address == null) {
					this.addr = "unknown";
				} else if (typeof address === "string") {
					this.addr = address;
				} else {
					this.addr = `${address.address}:${address.port}`;
					ctx.port = address.port;
				}
				console.log(this.addr);
			})
			.on("error", (err) => {
				log(`[server error: ${err?.message || err}`);
			})
			.on("close", () => {
				log(`server on ${this.addr} closed`);
			});
	}

	private onSocket = async (sock: Socket) => {
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 10_000);

		try {
			const address = sock.remoteAddress ?? "0.0.0.0";
			const port = sock.remotePort ?? 0;
			const remoteAddr = `/ip4/${address}/tcp/${port}`;

			const maConn = new SocketMultiaddrConnection({
				socket: sock,
				remoteAddr,
				log,
			});

			// 🔒 🔀 Upgrade inbound connection (TLS + mux, or plaintext+mux if Upgrader.encrypt=false)
			const upgraded = await this.upgrader.upgradeInbound(maConn, {
				muxed: true,
				direction: "inbound",
				remotePeer: { id: address, host: "127.0.0.1", port },
				// Upgrader decides encrypt=true for "normal" inbound connections
				// or you can add an `encrypt` flag here if you want special plaintext listeners.
			});

			const connection = upgraded as Connection;

			// hand the fully upgraded connection to the rest of the system
			// ConnectionHandler is now `(conn: Connection) => void | Promise<void>`
			await this.connectionHandler(connection);

			const emitter = connection as any;
			if (typeof emitter.once === "function") {
				emitter.once("close", () => {
					log("[node] connection closed");
				});
			}
		} catch (err) {
			log(`Error handling socket: ${err}`);
			sock.destroy();
		}
	};

	async listen(ctx: PeerInfo) {
		if (this.server.listening) return;

		const [error] = await this.resume(ctx);
		log("listening on %s", this.server.address());
		if (error) return safeError(error);
	}

	async resume(ctx: PeerInfo) {
		return await safeTry(() => {
			return new Promise<void>((resolve, reject) => {
				const onListen = () => {
					const address = this.server.address() as AddressInfo;
					ctx.port = address.port;
					resolve();
				};
				this.server.once("error", reject);
				this.server.listen(ctx.port, ctx.host, onListen);
			});
		});
	}

	async pause() {
		this.server.close();
	}
}
