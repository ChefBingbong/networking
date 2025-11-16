import type { Multiaddr } from "@multiformats/multiaddr";
import debug from "debug";
import type { TcpSocketConnectOpts } from "net";
import net from "node:net";
import type { Secp256k1PrivateKey } from "../../secp256k1/secp256k1";
import {
	type SafeError,
	type SafePromise,
	type SafeResult,
	safeError,
	safeResult,
	safeSyncTry,
	safeTry,
} from "../../utils/safe";
import { multiaddrToNetConfig } from "../../utils/utils";
import {
	type ConnectionHandler,
	MuxedConnection,
	type StreamOpenHandler,
} from "../connection";
import { Encrypter } from "../connection-encrypter";
import { TransportListener } from "./transport-listener";

const log = debug("p2p:transport");

type TransportDialOpts = {
	timeoutMs?: number;
	shouldCreateConnection?: boolean;
	maxActiveDials: number;
};

export type CreateTransportOptions = {
	frameHandler: ConnectionHandler;
	streamOpenHandler?: StreamOpenHandler;
};

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

	async dial(peerId: Multiaddr, timeoutMs = 10_000) {
		const peerIdStr = peerId.toString();
		const netOptions = multiaddrToNetConfig(peerId) as TcpSocketConnectOpts;

		const existingConn = this.checkAndReturnExistingConnection(peerId);
		if (existingConn) return existingConn;

		const dialPromise = this.scheduleDial(async () => {
			const sock = net.createConnection(netOptions);

			sock.setNoDelay(true);
			sock.setKeepAlive(true, 10_000);

			return await new Promise<SafeResult<MuxedConnection> | SafeError<Error>>(
				(resolve) => {
					const cleanup = () => {
						clearTimeout(timer);
						sock.off("connect", onConnect);
						sock.off("error", onError);
					};

					const onError = (err: Error) => {
						cleanup();
						sock.destroy(err);
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
						sock.destroy(err);
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
		const [encryptionError, result] = await safeTry(() =>
			this.encrypter.encrypt(socket, false),
		);
		if (encryptionError) {
			return safeError(encryptionError);
		}
		const [connectionError, connection] = safeSyncTry(
			() => new MuxedConnection(peerId, result.socket),
		);

		if (connectionError) {
			return safeError(connectionError);
		}
		this.connectionCache.set(peerId.toString(), connection);
		connection.socket.once("close", () => {
			this.connectionCache.delete(peerId.toString());
		});
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
