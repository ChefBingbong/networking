// cert.mjs

import { secp256k1 as secp } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import * as x509 from "@peculiar/x509";
import crypto from "node:crypto";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import type { Secp256k1PrivateKey } from "../secp256k1/secp256k1";

const NODE_BINDING_OID = "1.3.6.1.4.1.55555.1.1";

function tlvBinding(pubCompressed: Uint8Array, sig64: Uint8Array) {
	const len = 1 + 2 + pubCompressed.length + 1 + 2 + sig64.length;
	const out = new Uint8Array(len);
	let i = 0;
	out[i++] = 0x01;
	out[i++] = (pubCompressed.length >>> 8) & 0xff;
	out[i++] = pubCompressed.length & 0xff;
	out.set(pubCompressed, i);
	i += pubCompressed.length;
	out[i++] = 0x02;
	out[i++] = (sig64.length >>> 8) & 0xff;
	out[i++] = sig64.length & 0xff;
	out.set(sig64, i);
	return out.buffer;
}

export async function generateBoundCertificate(keyPair: Secp256k1PrivateKey) {
	// 1) Create or load your node's secp256k1 identity
	const nodePriv = keyPair.raw;
	const nodePubCompressed = keyPair.publicKey.raw;

	// 2) Create TLS keypair (P-256) to go inside the certificate
	const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
	const tlsKeys = await crypto.webcrypto.subtle.generateKey(alg, true, [
		"sign",
		"verify",
	]);

	// 3) Export SPKI of TLS public key, sign it with node key (binding)
	const spkiAB = await crypto.webcrypto.subtle.exportKey(
		"spki",
		tlsKeys.publicKey,
	);
	const digest = sha256(new Uint8Array(spkiAB));
	const sigDer = secp.sign(digest, nodePriv);
	const sigRS = secp.Signature.fromDER(sigDer.toDERHex()).toCompactRawBytes(); // 64-byte r||s

	// 4) Build the custom extension carrying (nodePubCompressed, sigRS)
	const bindingExt = new x509.Extension(
		NODE_BINDING_OID,
		true,
		tlvBinding(nodePubCompressed, sigRS),
	);

	// 5) Issue a self-signed cert for TLS keypair
	const now = Date.now();
	const notBefore = new Date(now - 5 * 60 * 1000);
	const notAfter = new Date(now + 365 * 24 * 60 * 60 * 1000);
	notAfter.setMilliseconds(0);

	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		serialNumber: String(Math.floor(Math.random() * 1e9)),
		name: "CN=custom-p2p-node",
		notBefore,
		notAfter,
		signingAlgorithm: alg,
		keys: tlsKeys,
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(
				x509.KeyUsageFlags.digitalSignature |
					x509.KeyUsageFlags.keyEncipherment,
				true,
			),
			await x509.SubjectKeyIdentifierExtension.create(tlsKeys.publicKey),
			bindingExt,
		],
	});

	// 6) Export TLS private key in PKCS#8 → PEM for node:tls
	const pkcs8 = await crypto.webcrypto.subtle.exportKey(
		"pkcs8",
		tlsKeys.privateKey,
	);
	const keyPEM = pkcs8ToPEM(pkcs8);
	const certPEM = cert.toString("pem");

	return {
		certPEM,
		keyPEM,
		nodeKey: { private: nodePriv, publicCompressed: nodePubCompressed },
	};
}

function pkcs8ToPEM(keydata: ArrayBuffer): string {
	return formatAsPem(uint8ArrayToString(new Uint8Array(keydata), "base64"));
}

function formatAsPem(str: string): string {
	let finalString = "-----BEGIN PRIVATE KEY-----\n";

	while (str.length > 0) {
		finalString += str.substring(0, 64) + "\n";
		str = str.substring(64);
	}

	finalString = `${finalString}-----END PRIVATE KEY-----`;

	return finalString;
}

export async function verifyPeerCertificate(
	certRaw: Buffer | Uint8Array | ArrayBuffer,

	opts: {
		now?: Date; // default: new Date()
		expectedNodePubCompressed?: Uint8Array; // if you want to assert a specific node
		allowExpired?: boolean; // set true to skip time checks
	} = {},
) {
	const x = new x509.X509Certificate(certRaw);
	const now = opts.now ?? new Date();

	if (!opts.allowExpired) {
		if (x.notBefore > now) throw new Error("certificate not yet valid");
		if (x.notAfter < now) throw new Error("certificate expired");
	}

	const selfOK = await x.verify();
	if (!selfOK) throw new Error("invalid self-signature");

	const isSelf = await x.isSelfSigned();
	if (!isSelf) throw new Error("certificate must be self-signed");

	const ext = x.extensions.find((e) => e.type === NODE_BINDING_OID);
	if (!ext) throw new Error("missing node binding extension");

	// Parse TLV
	const u8 = new Uint8Array(ext.value);
	let i = 0;
	const rd16 = () => (u8[i++]! << 8) | u8[i++]!;

	if (u8[i++] !== 0x01) throw new Error("binding: missing pub tag");
	const pubLen = rd16();
	const pub = u8.slice(i, i + pubLen);
	i += pubLen;
	if (u8[i++] !== 0x02) throw new Error("binding: missing sig tag");
	const sigLen = rd16();
	const sig = u8.slice(i, i + sigLen);

	if (pub.length !== 33) throw new Error("binding: pub must be 33 bytes");
	if (sig.length !== 64) throw new Error("binding: sig must be 64 bytes");

	// Export SPKI of the TLS public key and verify binding
	const cryptoPubKey = await x.publicKey.export();
	const spkiAB = await crypto.webcrypto.subtle.exportKey("spki", cryptoPubKey);
	const digest = sha256(new Uint8Array(spkiAB));

	const ok = secp.verify(sig, digest, pub);
	if (!ok) throw new Error("node binding signature invalid");

	if (opts.expectedNodePubCompressed) {
		const exp = opts.expectedNodePubCompressed;
		if (exp.length !== pub.length || exp.some((b, j) => b !== pub[j])) {
			throw new Error("peer node identity mismatch");
		}
	}

	return { nodePubCompressed: pub, spki: new Uint8Array(spkiAB) };
}
