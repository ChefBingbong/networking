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

	constructor(
		ctx: PeerInfo,
		encrypter: Encrypter,
		frameHandler: ConnectionHandler,
	) {
		this.peerContext = ctx;
		this.encrypter = encrypter;
		this.frameHandler = frameHandler;
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

		const [encryptionError, result] = await safeTry(() =>
			this.encrypter.encrypt(sock, true),
		);
		if (encryptionError) {
			log(`failed to encrypt tls ${encryptionError}`);
			sock.destroy();
			return;
		}
		this.sockets.add(sock);
		sock.once("close", () => {
			this.sockets.delete(sock);
		});
		const connection = new MuxedConnection(this.peerContext, result.socket);
		connection.setOnFrame((f) => this.frameHandler(connection, f));
	};

	async listen(ctx: PeerInfo) {
		if (this.server.listening) return;

		const [error, _] = await safeTry(() => {
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

		log("listening on %s", this.server.address());
		if (error) return safeError(error);
	}

	pause() {
		this.server.close();
	}
}
