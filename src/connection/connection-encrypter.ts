import { createHash } from "crypto";
import debug from "debug";
import type { Socket } from "node:net";
import {
	TLSSocket,
	type TLSSocketOptions,
	connect as tlsConnect,
} from "node:tls";
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import { safeError, safeResult } from "../utils/safe";
import { generateBoundCertificate, verifyPeerCertificate } from "./cert";
import type { EncrypterResult, EncryptionCredentials } from "./types";

const log = debug("p2p:encrypter");

export class Encrypter {
	private trustedCache: Map<string, any> = new Map();

	constructor(private keyPair: Secp256k1PrivateKey) {}

	private fingerprint(raw: Buffer) {
		return createHash("sha256").update(raw).digest("hex");
	}

	async encrypt(raw: Socket, isServer: boolean) {
		try {
			const creds = await generateBoundCertificate(this.keyPair);
			const tlsSocket = await this.upgradeToTlsSocket(raw, creds, isServer);

			const result = await new Promise<EncrypterResult>((resolve, reject) => {
				const onError = (e: Error) => {
					tlsSocket.destroy();
					cleanup();
					reject(e);
				};
				const onReady = async () => {
					const result = await this.onTlsConnected(tlsSocket);
					cleanup();
					resolve(result);
				};
				const cleanup = () => {
					tlsSocket.off("secure" as any, onReady);
					tlsSocket.off("error", onError);
				};
				tlsSocket.once("secure" as any, onReady);
				tlsSocket.once("error", onError);
			});
			return safeResult(result);
		} catch (error) {
			log("encryption handshake failed:", error);
			return safeError(error);
		}
	}

	private async onTlsConnected(tlsSocket: TLSSocket) {
		const peer = tlsSocket.getPeerCertificate(true);
		const fp = this.fingerprint(peer.raw);

		if (this.trustedCache.has(fp)) {
			const remoteInfo = this.trustedCache.get(fp);
			return { socket: tlsSocket, remoteInfo };
		}

		const remoteInfo = await verifyPeerCertificate(peer.raw);
		this.trustedCache.set(fp, remoteInfo);
		return { socket: tlsSocket, remoteInfo };
	}

	private async upgradeToTlsSocket(
		raw: Socket,
		creds: EncryptionCredentials,
		isServer: boolean,
	) {
		const baseOpts: TLSSocketOptions = {
			cert: creds.certPEM,
			key: creds.keyPEM,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			rejectUnauthorized: false,
		};

		if (isServer) {
			return new TLSSocket(raw, {
				...baseOpts,
				isServer: true,
				requestCert: true,
			});
		}
		return tlsConnect({ ...baseOpts, socket: raw });
	}
}
