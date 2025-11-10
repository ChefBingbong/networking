import { CID } from "multiformats";
import type { Digest } from "multiformats/hashes/digest.js";
import { identity } from "multiformats/hashes/identity";
import { equals as uint8ArrayEquals } from "uint8arrays/equals";
import { hashAndSign, hashAndVerify } from "./index.js";
import * as pb from "./keys";
import {
	compressSecp256k1PublicKey,
	computeSecp256k1PublicKey,
	validateSecp256k1PrivateKey,
	validateSecp256k1PublicKey,
} from "./utils.js";

export function publicKeyToProtobuf(key: Secp256k1PublicKey): Uint8Array {
	return pb.PublicKey.encode({
		Type: pb.KeyType[key.type],
		Data: key.raw,
	});
}
export class Secp256k1PublicKey {
	public readonly type = "secp256k1";
	public readonly raw: Uint8Array;
	public readonly _key: Uint8Array;

	constructor(key: Uint8Array) {
		this._key = validateSecp256k1PublicKey(key);
		this.raw = compressSecp256k1PublicKey(this._key);
	}

	equals(key: any): boolean {
		if (key == null || !(key.raw instanceof Uint8Array)) {
			return false;
		}

		return uint8ArrayEquals(this.raw, key.raw);
	}

	toMultihash(): Digest<0x0, number> {
		return identity.digest(publicKeyToProtobuf(this));
	}

	toCID(): CID<unknown, 114, 0x0, 1> {
		return CID.createV1(114, this.toMultihash());
	}

	toString() {
		return Buffer.from(this.raw).toString("hex");
	}

	verify(data: Uint8Array, sig: Uint8Array): boolean {
		return hashAndVerify(this._key, sig, data);
	}
}

export class Secp256k1PrivateKey {
	public readonly type = "secp256k1";
	public readonly raw: Uint8Array;
	public readonly publicKey: Secp256k1PublicKey;

	constructor(key: Uint8Array, publicKey?: Uint8Array) {
		this.raw = validateSecp256k1PrivateKey(key);
		this.publicKey = new Secp256k1PublicKey(
			publicKey ?? computeSecp256k1PublicKey(key),
		);
	}

	equals(key?: any): boolean {
		if (key == null || !(key.raw instanceof Uint8Array)) {
			return false;
		}

		return uint8ArrayEquals(this.raw, key.raw);
	}

	sign(message: Uint8Array): Uint8Array {
		return hashAndSign(this.raw, message);
	}
}
