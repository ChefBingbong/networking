// src/transport.ts
import net from "net";
import { type Frame, PROTOCOL_VERSION } from "./protocol";
import { MuxedConnection } from "./mux";
import { deriveKeys, generateECDH } from "./crypto2";

export interface PeerInfo {
	id: string;
	host: string;
	port: number;
}

export interface NodeContext {
	id: string;
	host: string;
	port: number;
	isBootstrap: boolean;
	peers: Map<string, PeerInfo>;
}

export function createServer(
	ctx: NodeContext,
	onConn: (mc: MuxedConnection, remote: net.Socket) => void,
) {
	const server = net.createServer((sock) => {
    console.log(sock.remotePort)
		return onConn(new MuxedConnection(sock), sock)
  }
	);
	server.listen(ctx.port, ctx.host);
	console.log(`[${ctx.id}] listening on ${ctx.host}:${ctx.port}`);
	return server;
}

export async function connect(
	ctx: NodeContext,
	target: PeerInfo,
	isInitiator = true,
): Promise<MuxedConnection> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(
			{ host: target.host, port: target.port },
			async (s) => {
				const mc = new MuxedConnection(sock);
				try {
					await performUpgrade(mc, ctx, isInitiator);
          console.log(target.port)
					console.log(`[${ctx.id}] upgraded connection to ${target.id}`);
					resolve(mc);
				} catch (e) {
					console.error(`[${ctx.id}] upgrade to ${target.id} failed:`, e);
					sock.destroy();
					reject(e);
				}
			},
		);
		sock.on("error", (err) => {
			console.error(`[${ctx.id}] dial error to ${target.id}:`, err);
			reject(err);
		});
    sock.on("close", (err) => {
			console.error(`[${ctx.id}] dial error to ${target.id}:`, err);
			reject(err);
		});
	});
}

/**
 * Connection Upgrade (with timeout):
 * - Exchange HELLO / HELLO_ACK carrying ephemeral ECDH pubkeys
 * - Both sides send SECURE (resolves handshake)
 * - Derive keys and set secure mode
 */
export async function performUpgrade(
	mc: MuxedConnection,
	ctx: NodeContext,
	isInitiator: boolean,
	timeoutMs = 10_000,
) {
	const ecdh = generateECDH();
	const myPub = ecdh.getPublicKey("base64");
	let remotePub: string | null = null;

	const handshakeP = new Promise<void>((res) => {
		mc.setOnFrame((f: Frame) => {
			if (f.t === "HELLO") {
				console.log(`[${ctx.id}] <- HELLO`);
				remotePub = f.payload.pub as string;
				mc.send({
					t: "HELLO_ACK",
					payload: { pub: myPub, id: ctx.id, v: PROTOCOL_VERSION },
				});
				console.log(`[${ctx.id}] -> HELLO_ACK`);
				mc.send({ t: "SECURE" });
				console.log(`[${ctx.id}] -> SECURE`);
			} else if (f.t === "HELLO_ACK") {
				console.log(`[${ctx.id}] <- HELLO_ACK`);
				remotePub = f.payload.pub as string;
				mc.send({ t: "SECURE" });
				console.log(`[${ctx.id}] -> SECURE`);
			} else if (f.t === "SECURE") {
				console.log(`[${ctx.id}] <- SECURE`);
				res();
			}
		});

		if (isInitiator) {
			console.log(`[${ctx.id}] -> HELLO`);
			mc.send({
				t: "HELLO",
				payload: { pub: myPub, id: ctx.id, v: PROTOCOL_VERSION },
			});
		}
	});

	await Promise.race([
		handshakeP,
		new Promise<void>((_, rej) =>
			setTimeout(() => rej(new Error("handshake timeout")), timeoutMs),
		),
	]);

	if (!remotePub) throw new Error("no remote pubkey");
	const shared = ecdh.computeSecret(Buffer.from(remotePub, "base64"));
	const km = deriveKeys(shared, isInitiator);
	mc.setSecure(km);
}
