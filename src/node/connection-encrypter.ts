import { createHash } from "crypto";
import debug from "debug";
import type { Socket } from "node:net";
import {
	TLSSocket,
	type TLSSocketOptions,
	connect as tlsConnect,
} from "node:tls";
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import { generateBoundCertificate, verifyPeerCertificate } from "./cert";

const log = debug("p2p:encrypter");

export class Encrypter {
	private trustedCache: Map<string, any> = new Map(); // fingerprint -> remoteInfo

	constructor(private keyPair: Secp256k1PrivateKey) {}

	private fingerprint(raw: Buffer) {
		return createHash("sha256").update(raw).digest("hex");
	}

	/**
	 * Encrypt (wrap) a raw socket into TLS. We always perform the TLS handshake;
	 * however, to avoid repeated expensive verification of the peer certificate,
	 * we cache verified peer info keyed by the certificate raw fingerprint.
	 *
	 * If `isServer` === true we act as server side of TLS, otherwise client.
	 *
	 * Returns: { socket: TLSSocket, remoteInfo } where remoteInfo is result of verifyPeerCertificate
	 */
	async encrypt(raw: Socket, isServer: boolean) {
		const creds = await generateBoundCertificate(this.keyPair);
		const baseOpts: TLSSocketOptions = {
			cert: creds.certPEM,
			key: creds.keyPEM,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
			rejectUnauthorized: false,
		};

		let tlsSock: TLSSocket;
		if (isServer) {
			tlsSock = new TLSSocket(raw, {
				...baseOpts,
				isServer: true,
				requestCert: true,
			});
		} else {
			tlsSock = tlsConnect({
				...baseOpts,
				socket: raw,
			});
		}

		await new Promise<void>((resolve, reject) => {
			const onReady = () => {
				cleanup();
				resolve();
			};
			const onError = (e: Error) => {
				cleanup();
				reject(e);
			};
			const cleanup = () => {
				tlsSock.off("secure" as any, onReady);
				tlsSock.off("error", onError);
			};
			tlsSock.once("secure" as any, onReady);
			tlsSock.once("error", onError);
		});

		try {
			// If we have a cached remoteInfo for this peer certificate, use it
			const peer = tlsSock.getPeerCertificate(true);
			if (!peer || !peer.raw) {
				try {
					tlsSock.destroy();
				} catch {}
				throw new Error("no peer certificate presented");
			}
			const fp = this.fingerprint(peer.raw);

			// If cached, return cached result (skip expensive verify)
			if (this.trustedCache.has(fp)) {
				const remoteInfo = this.trustedCache.get(fp);
				log(
					"remote certificate found in cache; peer node:",
					Buffer.from(remoteInfo.nodePubCompressed).toString("hex"),
				);
				return { socket: tlsSock, remoteInfo };
			}

			log("verifying remote certificate");
			const remoteInfo = await verifyPeerCertificate(peer.raw);
			// cache it
			try {
				this.trustedCache.set(fp, remoteInfo);
			} catch {}
			log(
				"remote certificate OK; peer node:",
				Buffer.from(remoteInfo.nodePubCompressed).toString("hex"),
			);
			return { socket: tlsSock, remoteInfo };
		} catch (e) {
			tlsSock.destroy();
			throw e;
		}
	}
}
