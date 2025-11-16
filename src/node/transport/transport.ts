import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { TcpSocketConnectOpts } from "net";
import net, { type Server } from "node:net";
import type { Secp256k1PrivateKey } from "../../secp256k1/secp256k1";
import { safeError, safeResult, safeSyncTry, safeTry } from "../../utils/safe";
import { multiaddrToNetConfig } from "../../utils/utils";
import { type ConnectionHandler, MuxedConnection } from "../connection";
import { Encrypter } from "../connection-encrypter";
import { TransportListener } from "./transport-listener";

const log = debug("p2p:transport");

export class Transport {
	public server: Server | undefined;
	private encrypter: Encrypter;
	private connCache: Map<string, MuxedConnection> = new Map();

	constructor(privateKey: Secp256k1PrivateKey) {
		this.encrypter = new Encrypter(privateKey);
	}

	private cacheKey(target: Multiaddr) {
		return target.toString();
	}

	async dial(peerId: Multiaddr, timeoutMs = 10_000) {
		const netOptions = multiaddrToNetConfig(peerId) as TcpSocketConnectOpts;
		const key = this.cacheKey(peerId);

		// reuse an existing connection if healthy
		const cached = this.connCache.get(key);
		if (cached && !cached.socket.destroyed) {
			// return cached connection immediately
			return safeResult(cached);
		}

		const [sockErr, sock] = safeSyncTry(() => net.createConnection(netOptions));

		if (sockErr) return safeError(sockErr);
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 10_000);

		const [connectionError] = await safeTry(() => {
			return new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer);
					sock.off("connect", onReady);
					sock.off("error", onError);
				};

				const onReady = () => {
					cleanup();
					resolve();
				};
				const onError = (e: Error) => {
					cleanup();
					reject(e);
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
			log(`Failed to connect to ${peerId.toString()}: ${connectionError}`);
			return safeError(connectionError);
		}

		const [encryptionError, result] = await safeTry(() =>
			this.encrypter.encrypt(sock, false),
		);

		if (encryptionError) {
			log(
				`Failed to encrypt TLS connection to ${peerId.toString()}: ${encryptionError}`,
			);
			return safeError(encryptionError);
		}

		const mc = new MuxedConnection(peerId, result.socket);
		// cache and cleanup on close
		this.connCache.set(key, mc);
		mc.socket.once("close", () => {
			this.connCache.delete(key);
		});
		return safeResult(mc);
	}

	createListener(frameHandler: ConnectionHandler) {
		return new TransportListener({
			upgrader: this.encrypter,
			frameHandler,
		});
	}
}
