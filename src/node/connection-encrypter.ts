// encrypter.ts (unchanged)
import {
	TLSSocket,
	type TLSSocketOptions,
	connect as tlsConnect,
} from "node:tls";
import type { Socket } from "node:net";
import debug from "debug";
import { generateBoundCertificate, verifyPeerCertificate } from "./cert";
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";
import type { MuxedConnection } from "./connection";

const log = debug("p2p:encrypter");

export class Encrypter {
	constructor(private keyPair: Secp256k1PrivateKey) {}

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
				servername: "127.0.0.1",
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
			log("verifying remote certificate");
			const peer = tlsSock.getPeerCertificate(true);
			if (!peer || !peer.raw) {
				try {
					tlsSock.destroy();
				} catch {}
				throw new Error("no peer certificate presented");
			}
			const remoteInfo = await verifyPeerCertificate(peer.raw);
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
