import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { TcpSocketConnectOpts } from "net";
import net, { type Server } from "node:net";
import type { Secp256k1PrivateKey } from "../../secp256k1/secp256k1";
import { safeError, safeResult, safeSyncTry, safeTry } from "../../utils/safe";
import { multiaddrToNetConfig } from "../../utils/utils";
import {
	type ConnectionHandler,
	MuxedConnection,
	type StreamOpenHandler,
} from "../connection";
import { Encrypter } from "../connection-encrypter";
import { TransportListener } from "./transport-listener";

const log = debug("p2p:transport");

// tune this if needed
const MAX_ACTIVE_DIALS = 16;

export class Transport {
	public server: Server | undefined;
	private encrypter: Encrypter;
	private connCache: Map<string, MuxedConnection> = new Map();

	// NEW: dedupe and rate-limit dials
	private inFlightDials = new Map<
		string,
		Promise<[Error | undefined, MuxedConnection | undefined]>
	>();
	private activeDials = 0;
	private dialQueue: Array<() => void> = [];

	constructor(privateKey: Secp256k1PrivateKey) {
		this.encrypter = new Encrypter(privateKey);
	}

	private cacheKey(target: Multiaddr) {
		return target.toString();
	}

	private async scheduleDial<T>(fn: () => Promise<T>): Promise<T> {
		if (this.activeDials >= MAX_ACTIVE_DIALS) {
			await new Promise<void>((resolve) => this.dialQueue.push(resolve));
		}

		this.activeDials++;
		try {
			return await fn();
		} finally {
			this.activeDials--;
			const next = this.dialQueue.shift();
			if (next) next();
		}
	}

	async dial<T extends boolean = true>(
		peerId: Multiaddr,
		timeoutMs = 10_000,
		shouldCreateConnection: T = true as T,
	): Promise<[Error | undefined, MuxedConnection | undefined]> {
		const netOptions = multiaddrToNetConfig(peerId) as TcpSocketConnectOpts;
		const key = this.cacheKey(peerId);

		// reuse an existing healthy connection if present
		const cached = this.connCache.get(key);
		if (cached && !cached.socket.destroyed) {
			return safeResult(cached as any);
		}

		// reuse in-flight dial if one is already happening to this peer
		const existingDial = this.inFlightDials.get(key);
		if (existingDial) {
			return existingDial;
		}

		const dialPromise = this.scheduleDial(async () => {
			// ---- old dial logic lives here, but returns safeResult ----
			const [sockErr, sock] = safeSyncTry(() =>
				net.createConnection(netOptions),
			);
			if (sockErr) {
				log(`Failed to create TCP socket to ${peerId.toString()}: ${sockErr}`);
				return safeError(sockErr);
			}

			sock.setNoDelay(true);
			sock.setKeepAlive(true, 10_000);

			// wait for TCP connect with timeout
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
				sock.destroy();
				return safeError(connectionError);
			}

			// Encrypted or plaintext connection based on shouldCreateConnection
			if (shouldCreateConnection) {
				const [encryptionError, result] = await safeTry(() =>
					this.encrypter.encrypt(sock, false),
				);

				if (encryptionError) {
					log(
						`Failed to encrypt TLS connection to ${peerId.toString()}: ${encryptionError}`,
					);
					sock.destroy();
					return safeError(encryptionError);
				}

				const mc = new MuxedConnection(peerId, result.socket);
				this.connCache.set(key, mc);
				mc.socket.once("close", () => {
					this.connCache.delete(key);
				});
				return safeResult(mc as any);
			}

			// plaintext (e.g. adverts) – no TLS
			const mc = new MuxedConnection(peerId, sock);
			this.connCache.set(key, mc);
			mc.socket.once("close", () => {
				this.connCache.delete(key);
			});
			return safeResult(mc as any);
		});

		this.inFlightDials.set(key, dialPromise);
		const res = await dialPromise;
		this.inFlightDials.delete(key);
		return res;
	}

	createListener(
		frameHandler: ConnectionHandler,
		streamOpenHandler?: StreamOpenHandler,
	) {
		return new TransportListener({
			upgrader: this.encrypter,
			frameHandler,
			streamOpenHandler, // NEW
		});
	}
}
