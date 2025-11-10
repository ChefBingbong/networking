// transport/transport.ts

import debug from "debug";
import net, { type Server } from "net";
import type { PeerKeyPair } from "../../secp256k1/utils";
import type { PeerInfo, PeerRemote } from "../../session/nodeInfo";
import { safeError, safeResult, safeSyncTry, safeTry } from "../../utils/safe";
import { type ConnectionHandler, MuxedConnection } from "../connection";
import {
	type MultiaddrConnection,
	SocketMultiaddrConnection,
} from "../multi-addr-connection";
import type { Upgrader } from "../upgrader";
import { TransportListener } from "./transport-listener";

const log = debug("p2p:transport");

export class Transport {
	public server: Server | undefined;
	private keyPair: PeerKeyPair;
	public upgrader: Upgrader;

	// cache keyed by host:port -> upgraded Connection (MuxedConnection)
	private connCache: Map<string, MuxedConnection> = new Map();

	constructor(keyPair: PeerKeyPair, upgrader: Upgrader) {
		this.keyPair = keyPair;
		this.upgrader = upgrader;
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

		// Reuse upgraded connection if still alive
		const cached = this.connCache.get(key);
		if (cached && !cached.socket.destroyed) {
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

		// Wrap raw socket in MultiaddrConnection
		const remoteAddr = `/ip4/${target.host}/tcp/${target.port}`;
		const maConn: MultiaddrConnection = new SocketMultiaddrConnection({
			socket: sock,
			remoteAddr,
			log,
		});

		// decide if we should encrypt this connection:
		// - true  => TLS + mux
		// - false => plaintext + mux (e.g. for adverts/ephemeral)
		const encrypt = Boolean(shouldCreateConnection);

		// 🔒/🔓 Normal upgraded connection: Upgrader does TLS and/or mux
		const [upgradeError, upgraded] = await safeTry(() =>
			this.upgrader.upgradeOutbound(maConn, {
				muxed: true,
				direction: "outbound",
				remotePeer: target,
				// encrypt,
			}),
		);

		if (upgradeError) {
			log(
				`Failed to upgrade outbound connection to ${target.id}: ${upgradeError}`,
			);
			try {
				maConn.abort(upgradeError);
			} catch {}
			return safeError(upgradeError);
		}

		const conn = upgraded;

		// cache and evict on close
		this.connCache.set(key, maConn);

		// Connection is expected to be an EventEmitter in your impl
		const emitter = conn as any;
		if (typeof emitter.once === "function") {
			emitter.once("close", () => {
				this.connCache.delete(key);
			});
		}

		return safeResult(conn as any);
	}

	createListener(ctx: PeerInfo, frameHandler: ConnectionHandler) {
		return new TransportListener(ctx, this.upgrader, frameHandler);
	}
}
