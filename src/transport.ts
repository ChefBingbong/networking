// src/transport.ts
import net, { type AddressInfo, type Server, type Socket } from "node:net";
import debug from "debug";
import { MuxedConnection } from "./connection";
import type { NodeContext } from "../transport";
import type { PeerInfo } from "./node";
import { Encrypter } from "./connection-encrypter";

const log = debug("p2p:transport");

export type TransportOpts = {
	// decide per-connection if it should be TLS-upgraded
	shouldEncryptInbound?: (raw: Socket) => boolean;
	shouldEncryptOutbound?: (target: PeerInfo) => boolean;
};

export class Transport {
	public server: Server | undefined;
	public info: PeerInfo;
	private encrypter?: Encrypter;
	private opts: TransportOpts;

	constructor(info: PeerInfo, encrypter?: Encrypter, opts: TransportOpts = {}) {
		this.info = info;
		this.encrypter = encrypter;
		this.opts = opts;
	}

	listen(
		ctx: NodeContext,
		onConn: (mc: MuxedConnection, raw: Socket) => void,
	): Server {
		if (this.server) throw new Error("server already listening");

		this.server = net.createServer(async (raw) => {
			safeTuneSocket(raw);

			try {
				let sockForMux: Socket = raw;

				// TLS on-demand for inbound
				if (
					this.encrypter &&
					(await want(this.opts.shouldEncryptInbound?.(raw)))
				) {
					console.log("UPGRADING INB");

					const { socket: tlsSock } = await this.encrypter.upgradeInbound(raw);
					sockForMux = tlsSock as unknown as Socket;
				}

				const mc = new MuxedConnection(ctx, sockForMux);
				onConn(mc, sockForMux);
			} catch (err) {
				try {
					raw.destroy();
				} catch {}
				log(`[${ctx.id}] inbound error: ${String(err)}`);
			}
		});

		this.server.on("error", (err) => {
			log(`[${ctx.id}] server error: ${err?.message || err}`);
		});

		this.server.listen(this.info.port, this.info.host, () => {
			const a = this.server!.address() as AddressInfo;
			ctx.port = a.port;
			log(`[${ctx.id}] listening on ${ctx.host}:${ctx.port} (TCP default)`);
		});

		return this.server;
	}

	dial(
		ctx: NodeContext,
		target: PeerInfo,
		timeoutMs = 10_000,
	): Promise<MuxedConnection> {
		return new Promise((resolve, reject) => {
			const raw = net.connect({ host: target.host, port: target.port });
			safeTuneSocket(raw);

			const timer = setTimeout(() => {
				try {
					raw.destroy(new Error(`connection timeout after ${timeoutMs}ms`));
				} catch {}
			}, timeoutMs);

			const cleanup = () => {
				clearTimeout(timer);
				raw.removeAllListeners();
			};

			raw.on("connect", async () => {
				try {
					let sockForMux: Socket = raw;

					// TLS on-demand for outbound
					if (
						this.encrypter &&
						(await want(this.opts.shouldEncryptOutbound?.(target)))
					) {
						console.log("UPGRADING OUTBOUND");
						const { socket: tlsSock } = await this.encrypter.upgradeOutbound(
							raw,
							target,
						);
						sockForMux = tlsSock as unknown as Socket;
					}

					const mc = new MuxedConnection(ctx, sockForMux);
					log(
						`[${ctx.id}] connected to ${target.id} at ${target.host}:${target.port} (${sockForMux instanceof net.Socket ? "tcp" : "tls"})`,
					);
					cleanup();
					resolve(mc);
				} catch (err) {
					cleanup();
					reject(wrapConnErr(target, err));
				}
			});

			raw.once("error", (err) => {
				cleanup();
				reject(wrapConnErr(target, err));
			});
		});
	}
}

function safeTuneSocket(sock: Socket) {
	//   try { sock.setNoDelay(true); } catch {}
	//   try { sock.setKeepAlive(true, 10_000); } catch {}
}

function wrapConnErr(target: PeerInfo, err: any): Error {
	const msg = err?.message || String(err);
	const e = new Error(
		`connection error ${target.host}:${target.port} - ${msg}`,
	);
	(e as any).cause = err;
	return e;
}

async function want(v?: boolean | Promise<boolean>) {
	return v instanceof Promise ? await v : !!v;
}
