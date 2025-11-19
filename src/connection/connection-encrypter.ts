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
	private trustedCache: Map<string, any> = new Map();

	constructor(private keyPair: Secp256k1PrivateKey) {}

	private fingerprint(raw: Buffer) {
		return createHash("sha256").update(raw).digest("hex");
	}

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
			const peer = tlsSock.getPeerCertificate(true);
			if (!peer || !peer.raw) {
				try {
					tlsSock.destroy();
				} catch {}
				throw new Error("no peer certificate presented");
			}
			const fp = this.fingerprint(peer.raw);

			if (this.trustedCache.has(fp)) {
				const remoteInfo = this.trustedCache.get(fp);
				log(
					"remote certificate found in cache; peer node:",
					Buffer.from(remoteInfo.nodePubCompressed).toString("hex"),
				);
				return { socket: tlsSock, remoteInfo };
			}

			const remoteInfo = await verifyPeerCertificate(peer.raw);
			this.trustedCache.set(fp, remoteInfo);
			return { socket: tlsSock, remoteInfo };
		} catch (e) {
			try {
				tlsSock.destroy();
			} catch {}
			throw e;
		}
	}
}
