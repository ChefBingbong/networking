import type { AbortOptions } from "@libp2p/interfaces/dist/src";
import { type Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import net, { type Server, type Socket } from "net";
import type { NetConfig } from "../../utils/getNetConfig";
import { safeError, safeTry } from "../../utils/safe";
import { multiaddrToNetConfig } from "../../utils/utils";
import {
	type ConnectionHandler,
	MuxedConnection,
	type StreamOpenHandler,
} from "../connection";
import { Encrypter } from "../connection-encrypter";

const log = debug("p2p:transport");

export interface TCPSocketOptions extends AbortOptions {
	noDelay?: boolean;
	keepAlive?: boolean;
	allowHalfOpen?: boolean;
}
export interface CreateListenerOptions {
	upgrader: Encrypter;
}
export interface TCPCreateListenerOptions
	extends CreateListenerOptions,
		TCPSocketOptions {}

type Status =
	| { code: "INACTIVE" }
	| {
			code: "ACTIVE";
			listeningAddr: Multiaddr;
			netConfig: NetConfig;
	  };

interface Context extends TCPCreateListenerOptions {
	socketInactivityTimeout?: number;
	socketCloseTimeout?: number;
	maxConnections?: number;
	backlog?: number;
	frameHandler: ConnectionHandler;
	streamOpenHandler?: StreamOpenHandler;
}
export class TransportListener {
	public server: Server;
	private addr: string = "unknown";
	public context: Context;
	private status: Status = { code: "INACTIVE" };

	constructor(context: Context) {
		this.context = context;
		this.server = net.createServer(context, this.onSocket);
		this.server
			.on("listening,", () => {
				const address = this.server.address();

				if (address == null) {
					this.addr = "unknown";
				} else if (typeof address === "string") {
					this.addr = address;
				} else {
					this.addr = `${address.address}:${address.port}`;
				}
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

		if (this.status.code !== "ACTIVE") {
			sock.destroy();
			throw new Error("Server is not listening yet");
		}
		try {
			let socketToUse = sock;

			const [encryptionError, result] = await safeTry(() =>
				this.context.upgrader.encrypt(sock, true),
			);
			if (encryptionError) {
				log(`TLS encryption failed: ${encryptionError}`);
				sock.destroy();
				return;
			}

			socketToUse = result.socket;
			const connection = new MuxedConnection(
				this.status.listeningAddr,
				socketToUse,
			);
			connection.setOnFrame((f) => this.context.frameHandler(connection, f));

			if (this.context.streamOpenHandler) {
				connection.setOnStreamOpen(this.context.streamOpenHandler);
			}

			socketToUse.once("close", () => {
				log(`[node] socket closed`);
			});
		} catch (err) {
			log(`Error handling socket: ${err}`);
			sock.destroy();
		}
	};

	async listen(peerId: Multiaddr) {
		if (this.status.code === "ACTIVE") {
			throw new Error("server is already listening");
		}

		this.status = {
			code: "ACTIVE",
			listeningAddr: peerId,
			peerId,
			netConfig: multiaddrToNetConfig(peerId),
		};

		await this.resume();
		log("listening on %s", this.server.address());
	}

	async resume() {
		if (this.server.listening || this.status.code === "INACTIVE") {
			return;
		}

		const netConfig = this.status.netConfig;

		const [error, _] = await safeTry(() => {
			return new Promise<void>((resolve, reject) => {
				this.server.once("error", reject);
				this.server.listen(netConfig, resolve);
			});
		});
		if (error) return safeError(error);
		this.status = { ...this.status, code: "ACTIVE" };
	}

	async pause() {
		this.server.close();
	}
}
