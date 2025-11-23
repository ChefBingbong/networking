import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { TcpSocketConnectOpts } from "net";
import net from "node:net";
import { Encrypter } from "../../connection";
import { MuxedConnection } from "../../connection/connection";
import type { Secp256k1PrivateKey } from "../../secp256k1/secp256k1";
import {
	type SafeError,
	type SafePromise,
	type SafeResult,
	safeError,
	safeResult,
	safeSyncTry,
} from "../../utils/safe";
import { multiaddrToNetConfig } from "../../utils/utils";
import { TransportListener } from "./transport-listener";
import type { CreateTransportOptions, TransportDialOpts } from "./types";

const log = debug("p2p:transport");

export class Transport {
	private encrypter: Encrypter;
	private connectionCache: Map<string, MuxedConnection> = new Map();
	private inFlightDials = new Map<string, SafePromise<MuxedConnection>>();

	private dialOpts: TransportDialOpts;
	private dialQueue: Array<() => void> = [];
	private activeDials = 0;

	constructor(privateKey: Secp256k1PrivateKey, dialOpts: TransportDialOpts) {
		this.encrypter = new Encrypter(privateKey);
		this.dialOpts = dialOpts;
	}

	async dial(peerId: Multiaddr, timeoutMs = 60_000) {
		const peerIdStr = peerId.toString();
		const netOptions = multiaddrToNetConfig(peerId) as TcpSocketConnectOpts;

		const existingConn = this.checkAndReturnExistingConnection(peerId);
		if (existingConn) return existingConn;

		const dialPromise = this.scheduleDial(async () => {
			const sock = net.createConnection(netOptions);

			sock.on("error", (err) => {
				log(`dial socket error to ${peerId.toString()}: ${err.message}`);
				try {
					sock.destroy();
				} catch {}
			});

			return await new Promise<SafeResult<MuxedConnection> | SafeError<Error>>(
				(resolve) => {
					const cleanup = () => {
						clearTimeout(timer);
						sock.off("connect", onConnect);
						sock.off("error", onError);
					};

					const onError = (err: Error) => {
						cleanup();
						try {
							sock.destroy();
						} catch {}
						resolve(safeError(err));
					};
					const onConnect = async () => {
						const [error, res] = await this.onConnect(sock, peerId);
						cleanup();
						if (error) onError(error);
						resolve(safeResult(res));
					};

					const onTimeout = () => {
						const err = new Error(`connection timeout after ${timeoutMs}ms`);
						cleanup();
						try {
							sock.destroy();
						} catch {}
						resolve(safeError(err));
					};

					sock.once("connect", onConnect);
					sock.once("error", onError);
					const timer = setTimeout(onTimeout, timeoutMs);
				},
			);
		});

		this.inFlightDials.set(peerIdStr, dialPromise);
		const [error, dialResult] = await dialPromise;
		this.inFlightDials.delete(peerIdStr);

		if (error) return safeError(error);
		return safeResult(dialResult);
	}

	private async scheduleDial(dialCallback: () => SafePromise<MuxedConnection>) {
		if (this.activeDials >= this.dialOpts.maxActiveDials) {
			await new Promise<void>((resolve) => this.dialQueue.push(resolve));
		}
		this.activeDials++;
		const [dialError, result] = await dialCallback();

		this.activeDials--;
		const nextDial = this.dialQueue.shift();
		nextDial?.();

		return dialError ? safeError(dialError) : safeResult(result);
	}

	private onConnect = async (socket: net.Socket, peerId: Multiaddr) => {
		const [encryptionError, result] = await this.encrypter.encrypt(
			socket,
			false,
		);
		if (encryptionError) {
			return safeError(encryptionError);
		}
		const [connectionError, connection] = safeSyncTry(
			() => new MuxedConnection(result.socket, { remoteAddr: peerId }),
		);

		if (connectionError) {
			return safeError(connectionError);
		}
		this.connectionCache.set(peerId.toString(), connection);

		return safeResult(connection);
	};

	private checkAndReturnExistingConnection(peerId: Multiaddr) {
		const cachedConnection = this.connectionCache.get(peerId.toString());

		if (cachedConnection && !cachedConnection.socket.destroyed) {
			return safeResult(cachedConnection);
		}

		const existingDial = this.inFlightDials.get(peerId.toString());
		if (existingDial) return existingDial;
	}

	createListener(params: CreateTransportOptions) {
		return new TransportListener({ upgrader: this.encrypter, ...params });
	}
}
