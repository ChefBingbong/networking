// src/transport.ts
import net, { type AddressInfo, type Server, type Socket } from "net";
import debug from "debug";
import { MuxedConnection } from "./connection";
import type { NodeContext, TransportOpts } from "../transport";
import type { PeerInfo } from "./node";
import { PROTOCOL_VERSION, type Frame } from "../protocol";
import { Encrypter } from "./connection-encrypter";
import type { TLSSocket } from "tls";
import type { PeerKeyPair } from "../secp256k1/utils";

const log = debug("p2p:transport");

export class Transport {
	public server: Server | undefined;
	public info: PeerInfo;
	private encrypter: Encrypter;

	constructor(info: PeerInfo, keyPair: PeerKeyPair) {
		this.info = info;
		const privateKey = keyPair.privateKey;
		this.encrypter = new Encrypter(privateKey);
	}

	listen(
		ctx: NodeContext,
		onConn: (mc: MuxedConnection, raw: Socket) => void,
	): Server {
		this.server = net.createServer(async (sock) => {
			safeTuneSocket(sock);

            try {
			const { socket } = await this.encrypter.encrypt(sock, true);
			const mc = new MuxedConnection(ctx, socket);

			return onConn(mc, sock);
            } catch (err) {
                try {
                    sock.destroy();
                } catch {}
                log(`[${ctx.id}] inbound error: ${String(err)}`);
            }
		});
		if (!this.server) throw new Error("server already listening");

		this.server.listen(ctx.port, ctx.host, () => {
			const a = this.server.address() as AddressInfo;
			ctx.port = a.port;
			log(`[${ctx.id}] listening on ${ctx.host}:${ctx.port}`);
		});

		this.server.on("error", (err) => {
			log(`[${ctx.id}] server error: ${err?.message || err}`);
		});

		return this.server;
	}

	dial(
		ctx: NodeContext,
		target: PeerInfo,
		timeoutMs = 10_000,
	): Promise<MuxedConnection> {
		return new Promise((resolve, reject) => {
			let connected = false;
			const sock = net.createConnection({
				host: target.host,
				port: target.port,
			});

			safeTuneSocket(sock);

			const onConnect = async () => {
				connected = true;
				clearTimeout(timer);
                try {
				// Wrap into mux and install lifecycle observers
				const { socket } = await this.encrypter.encrypt(sock, false);
				const mc = new MuxedConnection(ctx, socket);
				log(
					`[${ctx.id}] connected to ${target.id} at ${target.host}:${target.port}`,
				);
				resolve(mc);
            } catch (err) {
                reject(err)
            }
			};

			const onError = (err: any) => {
				clearTimeout(timer);
				if (!connected) {
					reject(wrapConnErr(target, err));
				} else {
					log(
						`[${ctx.id}] post-connect error to ${target.id}: ${err?.message || err}`,
					);
				}
			};

			const onTimeout = () => {
				const err = new Error(`connection timeout after ${timeoutMs}ms`);
				try {
					sock.destroy(err);
				} catch {}
			};

			const cleanup = () => {
				sock.removeListener("connect", onConnect);
				sock.removeListener("error", onError);
			};

			sock.once("connect", () => {
				cleanup();
				onConnect();
			});
			sock.once("error", (err) => {
				cleanup();
				onError(err);
			});

			const timer = setTimeout(onTimeout, timeoutMs);
		});
	}

	public async performUpgrade(
		ctx: PeerInfo,
		mc: MuxedConnection,
		isInitiator: boolean,
	) {
		const handshakeP = new Promise<void>((res) => {
			mc.setOnFrame((f: Frame) => {
				if (f.t === "HELLO") {
					log(`[${ctx.id}] <- HELLO`);
					mc.send({
						t: "HELLO_ACK",
						payload: { id: ctx.id, v: PROTOCOL_VERSION },
					});
					log(`[${ctx.id}] -> HELLO_ACK`);
					mc.send({ t: "SECURE" });
					log(`[${ctx.id}] -> SECURE`);
				} else if (f.t === "HELLO_ACK") {
					log(`[${ctx.id}] <- HELLO_ACK`);
					mc.send({ t: "SECURE" });
					log(`[${ctx.id}] -> SECURE`);
				} else if (f.t === "SECURE") {
					log(`[${ctx.id}] <- SECURE`);
					res();
				}
			});

			if (isInitiator) {
				log(`[${ctx.id}] -> HELLO`);
				mc.send({
					t: "HELLO",
					payload: { id: ctx.id, v: PROTOCOL_VERSION },
				});
			}
		});

		await Promise.race([
			handshakeP,
			new Promise<void>((_, rej) =>
				setTimeout(() => rej(new Error("handshake timeout")), 30_000),
			),
		]);
	}
}

/** Small helper to make sockets behave like libp2p TCP defaults */
function safeTuneSocket(sock: Socket) {
	try {
		sock.setNoDelay(true);
	} catch {}
	try {
		sock.setKeepAlive(true, 10_000);
	} catch {}
}

function wrapConnErr(target: PeerInfo, err: any): Error {
	const msg = err?.message || String(err);
	const e = new Error(
		`connection error ${target.host}:${target.port} - ${msg}`,
	);
	(e as any).cause = err;
	return e;
}
