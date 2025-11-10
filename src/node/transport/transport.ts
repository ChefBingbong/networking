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

	// simple connection cache keyed by host:port -> MuxedConnection
	private connCache: Map<string, MuxedConnection> = new Map();

	constructor(keyPair: PeerKeyPair) {
		this.keyPair = keyPair;
		this.encrypter = new Encrypter(keyPair.privateKey);
	}

	private cacheKey(target: PeerRemote) {
		return `${target.host}:${target.port}`;
	}

	async dial<T extends boolean = true>(
		ctx: PeerInfo,
		target: PeerRemote,
		timeoutMs = 10_000,
		shouldCreateConnection: T = true as T,
	) {
		const key = this.cacheKey(target);

		// reuse an existing connection if healthy
		const cached = this.connCache.get(key);
		if (cached && !cached.socket.destroyed) {
			// return cached connection immediately
			return safeResult(cached as any);
		}

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
			log(`Failed to connect to ${target.id}: ${connectionError}`);
			return safeError(connectionError);
		}

		// 🔒 Normal encrypted connection
		if (shouldCreateConnection) {
			const [encryptionError, result] = await safeTry(() =>
				this.encrypter.encrypt(sock, false),
			);

			if (encryptionError) {
				log(
					`Failed to encrypt TLS connection to ${target.id}: ${encryptionError}`,
				);
				return safeError(encryptionError);
			}

			const mc = new MuxedConnection(ctx, result.socket);
			// cache and cleanup on close
			this.connCache.set(key, mc);
			mc.socket.once("close", () => {
				this.connCache.delete(key);
			});
			return safeResult(mc);
		}

		// 📢 Advert / plaintext connection (no TLS)
		const mc = new MuxedConnection(ctx, sock);
		this.connCache.set(key, mc);
		mc.socket.once("close", () => {
			this.connCache.delete(key);
		});
		return safeResult(mc);
	}

	createListener(
		ctx: PeerInfo,
		frameHandler: ConnectionHandler,
		useEncryption: boolean = true,
	) {
		return new TransportListener(
			ctx,
			this.encrypter,
			frameHandler,
			useEncryption,
		);
	}
}
