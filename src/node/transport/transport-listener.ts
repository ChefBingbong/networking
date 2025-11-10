import debug from "debug";
import net, { type AddressInfo, type Server, type Socket } from "net";
import type { PeerInfo } from "../../session/nodeInfo";
import { safeError, safeTry } from "../../utils/safe";
import { type ConnectionHandler, MuxedConnection } from "../connection";
import { Encrypter } from "../connection-encrypter";

const log = debug("p2p:transport");

export class TransportListener {
	public server: Server;
	private encrypter: Encrypter;
	peerContext: PeerInfo;
	private addr: string = "unknown";
	private sockets: Set<Socket> = new Set();
	private frameHandler: ConnectionHandler;
	private useEncryption: boolean;

	constructor(
		ctx: PeerInfo,
		encrypter: Encrypter,
		frameHandler: ConnectionHandler,
		useEncryption: boolean,
	) {
		this.peerContext = ctx;
		this.encrypter = encrypter;
		this.frameHandler = frameHandler;
		this.useEncryption = useEncryption;
		this.server = net.createServer(this.onSocket);
		this.server
			.on("listening,", () => {
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
			let socketToUse = sock;

			const [encryptionError, result] = await safeTry(() =>
				this.encrypter.encrypt(sock, true),
			);
			if (encryptionError) {
				log(`TLS encryption failed: ${encryptionError}`);
				sock.destroy();
				return;
			}

			socketToUse = result.socket;
			const connection = new MuxedConnection(this.peerContext, socketToUse);
			connection.setOnFrame((f) => this.frameHandler(connection, f));

			socketToUse.once("close", () => {
				log(`[node] socket closed`);
			});
		} catch (err) {
			log(`Error handling socket: ${err}`);
			sock.destroy();
		}
	};

	async listen(ctx: PeerInfo) {
		if (this.server.listening) return;

		const [error, _] = await this.resume(ctx);
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
