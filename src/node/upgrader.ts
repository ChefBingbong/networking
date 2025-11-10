// src/connection/upgrader.ts

import type { Debugger as Logger } from "debug";
import type { Socket } from "net";
import type { TLSSocket } from "tls";
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import type { PeerRemote } from "../session/nodeInfo";
import type { Connection } from "./connection";
import { MuxedConnection, SingleStreamMuxer } from "./connection";
import { Encrypter } from "./connection-encrypter";
import {
	type MultiaddrConnection,
	SocketMultiaddrConnection,
} from "./multi-addr-connection";

export interface UpgraderOptions<E = unknown> {
	muxed?: boolean;
	remotePeer: PeerRemote;
	direction: any;
	events?: E;
}

export interface Upgrader {
	upgradeOutbound(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions<any>,
	): Promise<Connection>;

	upgradeInbound(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions<any>,
	): Promise<Connection>;

	openConnection(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions,
	): Promise<Connection>;

	createStream(
		conn: Connection,
		protocols: string | string[],
	): Promise<ReturnType<Connection["newStream"]>>;
}

export class NodeUpgrader implements Upgrader {
	private encrypter: Encrypter;
	private log: Logger;

	constructor(privateKey: Secp256k1PrivateKey, log: Logger) {
		this.encrypter = new Encrypter(privateKey);
		this.log = log;
	}

	upgradeOutbound(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions<any>,
	): Promise<Connection> {
		return this.openConnection(maConn, opts);
	}

	upgradeInbound(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions<any>,
	): Promise<Connection> {
		return this.openConnection(maConn, opts);
	}

	async openConnection(
		maConn: MultiaddrConnection,
		opts: UpgraderOptions,
	): Promise<Connection> {
		const isServer = opts.direction === "inbound";

		// 1) TLS on the raw socket
		const { socket: tlsSocket, remoteInfo } = await this.encrypt(
			maConn.socket,
			isServer,
		);

		this.log(
			"TLS %s OK, remote certificate for peer %s",
			opts.direction,
			Buffer.from(remoteInfo.nodePubCompressed).toString("hex"),
		);

		// 2) Wrap TLS socket back into a MultiaddrConnection
		const tlsMaConn = new SocketMultiaddrConnection({
			socket: tlsSocket as unknown as Socket,
			remoteAddr: maConn.remoteAddr,
			log: maConn.log,
		});

		// 3) Build muxer (for now SingleStreamMuxer)
		const muxer =
			opts.muxed === false
				? new SingleStreamMuxer(tlsMaConn) // still single-stream but you could also skip mux entirely
				: new SingleStreamMuxer(tlsMaConn);

		// 4) Build Connection
		const conn = new MuxedConnection({
			id: crypto.randomUUID?.() ?? Math.random().toString(16).slice(2),
			remoteAddr: tlsMaConn.remoteAddr,
			remotePeer: opts.remotePeer,
			direction: opts.direction,
			maConn: tlsMaConn,
			muxer,
			multiplexer: "tcp",
			encryption: "tls",
			log: maConn.log,
		});

		return conn;
	}

	async createStream(
		conn: Connection,
		protocols: string | string[],
	): Promise<ReturnType<Connection["newStream"]>> {
		return conn.newStream(protocols);
	}

	private async encrypt(
		raw: Socket,
		isServer: boolean,
	): Promise<{ socket: TLSSocket; remoteInfo: any }> {
		const { socket, remoteInfo } = await this.encrypter.encrypt(raw, isServer);
		return { socket: socket as TLSSocket, remoteInfo };
	}
}
