import debug from "debug";
import net, { type Server } from "net";
import type { PeerKeyPair } from "../../secp256k1/utils";
import type { PeerInfo, PeerRemote } from "../../session/nodeInfo";
import { safeError, safeResult, safeSyncTry, safeTry } from "../../utils/safe";
import { type ConnectionHandler, MuxedConnection } from "../connection";
import { Encrypter } from "../connection-encrypter";
import { TransportListener } from "./transport-listener";

const log = debug("p2p:transport");

export class Transport {
	public server: Server | undefined;
	private encrypter: Encrypter;
	private keyPair: PeerKeyPair;

	constructor(keyPair: PeerKeyPair) {
		this.keyPair = keyPair;
		this.encrypter = new Encrypter(keyPair.privateKey);
	}

	async dial(ctx: PeerInfo, target: PeerRemote, timeoutMs = 10_000) {
		const [sockErr, sock] = safeSyncTry(() =>
			net.createConnection({
				host: target.host,
				port: target.port,
			}),
		);

		if (sockErr) return safeError(sockErr);
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 10_000);

		const [connectionError] = await safeTry(() => {
			return new Promise<void>((resolve, reject) => {
				const onReady = () => {
					cleanup();
					resolve();
				};
				const onError = (e: Error) => {
					cleanup();
					reject(e);
				};
				const cleanup = () => {
					clearTimeout(timer);
					sock.off("connect" as any, onReady);
					sock.off("error", onError);
				};
				const onTimeout = () => {
					const err = new Error(`connection timeout after ${timeoutMs}ms`);
					cleanup();
					sock.destroy(err);
					reject(err);
				};

				sock.once("connect", onReady);
				sock.once("error", onError);
				const timer = setTimeout(onTimeout, timeoutMs);
			});
		});

		if (connectionError) {
			log(`failed to connect to ${target.id} ${connectionError}`);
			return safeError(connectionError);
		}

		const [encryptionError, result] = await safeTry(() =>
			this.encrypter.encrypt(sock, false),
		);

		if (result) return safeResult(new MuxedConnection(ctx, result.socket));

		log(`failed to encrypt tls ${target.id} ${encryptionError}`);
		return safeResult(new MuxedConnection(ctx, sock));
	}

	createListener(ctx: PeerInfo, frameHandler: ConnectionHandler) {
		return new TransportListener(ctx, this.encrypter, frameHandler);
	}
}
