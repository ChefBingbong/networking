import { secp256k1 as secp } from "@noble/curves/secp256k1";
import {
	Secp256k1PrivateKey,
	Secp256k1PrivateKey as Secp256k1PrivateKeyClass,
	Secp256k1PublicKey,
	Secp256k1PublicKey as Secp256k1PublicKeyClass,
} from "./secp256k1.js";

const PRIVATE_KEY_BYTE_LENGTH = 32;

export { PRIVATE_KEY_BYTE_LENGTH as privateKeyLength };

export function unmarshalSecp256k1PrivateKey(bytes: Uint8Array) {
	return new Secp256k1PrivateKeyClass(bytes);
}

export function unmarshalSecp256k1PublicKey(bytes: Uint8Array) {
	return new Secp256k1PublicKeyClass(bytes);
}

export async function generateSecp256k1KeyPair() {
	const privateKeyBytes = generateSecp256k1PrivateKey();
	return new Secp256k1PrivateKeyClass(privateKeyBytes);
}

export function compressSecp256k1PublicKey(key: Uint8Array): Uint8Array {
	const point = secp.ProjectivePoint.fromHex(key).toRawBytes(true);
	return point;
}

export function decompressSecp256k1PublicKey(key: Uint8Array): Uint8Array {
	const point = secp.ProjectivePoint.fromHex(key).toRawBytes(false);
	return point;
}

export function validateSecp256k1PrivateKey(key: Uint8Array): Uint8Array {
	secp.getPublicKey(key, true);

	return key;
}

export function validateSecp256k1PublicKey(key: Uint8Array): Uint8Array {
	secp.ProjectivePoint.fromHex(key);

	return key;
}

export function computeSecp256k1PublicKey(privateKey: Uint8Array): Uint8Array {
	return secp.getPublicKey(privateKey, false);
}

export function generateSecp256k1PrivateKey(): Uint8Array {
	return secp.utils.randomPrivateKey();
}

export function generateSecp256k1KeyPrivPubPair(
	overridePk?: Uint8Array<ArrayBufferLike>,
): PeerKeyPair {
	const privateKey = overridePk ?? generateSecp256k1PrivateKey();
	const publicKey = computeSecp256k1PublicKey(privateKey);
	return {
		privateKey: new Secp256k1PrivateKey(privateKey, publicKey),
		publicKey: new Secp256k1PublicKey(publicKey),
	};
}

export type PeerKeyPair = {
	privateKey: Secp256k1PrivateKey;
	publicKey: Secp256k1PublicKey;
};

/**
 * Repeat indefinitely
 * @param fn -
 * @param interval - in milliseconds
 */
export async function loopInterval(
	fn: () => Promise<void>,
	interval: number,
	condition = true,
) {
	while (condition) {
		await fn();
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}
