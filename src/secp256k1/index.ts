import { secp256k1 as secp } from "@noble/curves/secp256k1";
import type { MultihashDigest } from "multiformats";
import crypto from "node:crypto";
import type { Uint8ArrayList } from "uint8arraylist";
import * as pb from "./keys";
import type { Secp256k1PrivateKey, Secp256k1PublicKey } from "./secp256k1";
import {
	generateSecp256k1KeyPair,
	unmarshalSecp256k1PrivateKey,
	unmarshalSecp256k1PublicKey,
} from "./utils";

export async function generateKeyPair(): Promise<Secp256k1PrivateKey> {
	return generateSecp256k1KeyPair();
}

export function publicKeyFromProtobuf(buf: Uint8Array) {
	const { Data } = pb.PublicKey.decode(buf);
	const data = Data ?? new Uint8Array();

	return unmarshalSecp256k1PublicKey(data);
}

export function publicKeyFromRaw(buf: Uint8Array) {
	return unmarshalSecp256k1PublicKey(buf);
}

export function publicKeyFromMultihash(digest: MultihashDigest<0x0>) {
	const { Data } = pb.PublicKey.decode(digest.digest);
	const data = Data ?? new Uint8Array();

	return unmarshalSecp256k1PublicKey(data);
}

export function publicKeyToProtobuf(key: Secp256k1PublicKey) {
	return pb.PublicKey.encode({
		Type: pb.KeyType[key.type],
		Data: key.raw,
	});
}

export function privateKeyFromProtobuf(buf: Uint8Array) {
	const decoded = pb.PrivateKey.decode(buf);
	const data = decoded.Data ?? new Uint8Array();

	return unmarshalSecp256k1PrivateKey(data);
}

export function privateKeyFromRaw(buf: Uint8Array) {
	return unmarshalSecp256k1PrivateKey(buf);
}

export function privateKeyToProtobuf(key: Secp256k1PrivateKey) {
	return pb.PrivateKey.encode({
		Type: pb.KeyType[key.type],
		Data: key.raw,
	});
}

export function hashAndSign(
	key: Uint8Array,
	msg: Uint8Array | Uint8ArrayList,
): Uint8Array {
	const hash = crypto.createHash("sha256");

	if (msg instanceof Uint8Array) {
		hash.update(msg);
	} else {
		for (const buf of msg) {
			hash.update(buf);
		}
	}

	const digest = hash.digest();
	const signature = secp.sign(digest, key);
	return signature.toDERRawBytes();
}

export function hashAndVerify(
	key: Uint8Array,
	sig: Uint8Array,
	msg: Uint8Array | Uint8ArrayList,
): boolean {
	const hash = crypto.createHash("sha256");

	if (msg instanceof Uint8Array) {
		hash.update(msg);
	} else {
		for (const buf of msg) {
			hash.update(buf);
		}
	}

	const digest = hash.digest();
	return secp.verify(sig, digest, key);
}
