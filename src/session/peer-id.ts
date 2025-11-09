import type { MultihashDigest } from "multiformats";
import { base58btc } from "multiformats/bases/base58";
import { equals as uint8ArrayEquals } from "uint8arrays/equals";
import type {
	Secp256k1PrivateKey,
	Secp256k1PublicKey,
} from "../secp256k1/secp256k1";
import type { PeerId, PeerIdType } from "./nodeInfo";

const inspect = Symbol.for("nodejs.util.inspect.custom");

interface PeerIdInit<DigestCode extends number> {
	type: "secp256k1";
	multihash: MultihashDigest<DigestCode>;
}

interface Secp256k1PeerIdInit {
	multihash: MultihashDigest<0x0>;
	publicKey: Secp256k1PublicKey;
}

class PeerIdImpl<DigestCode extends number> {
	public type: PeerIdType;
	private readonly multihash: MultihashDigest<DigestCode>;
	public readonly publicKey?: Secp256k1PublicKey;
	private string?: string;

	constructor(init: PeerIdInit<DigestCode>) {
		this.type = init.type;
		this.multihash = init.multihash;

		Object.defineProperty(this, "string", {
			enumerable: false,
			writable: true,
		});
	}

	get [Symbol.toStringTag](): string {
		return `PeerId(${this.toString()})`;
	}

	toString(): string {
		if (this.string == null) {
			this.string = base58btc.encode(this.multihash.bytes).slice(1);
		}

		return this.string;
	}

	toMultihash(): MultihashDigest<DigestCode> {
		return this.multihash;
	}

	toJSON(): string {
		return this.toString();
	}

	/**
	 * Checks the equality of `this` peer against a given PeerId
	 */
	equals(id?: PeerId | Uint8Array | string): boolean {
		if (id == null) {
			return false;
		}

		if (id instanceof Uint8Array) {
			return uint8ArrayEquals(this.multihash.bytes, id);
		}
		if (typeof id === "string") {
			return this.toString() === id;
		}
		throw new Error("not valid Id");
	}

	[inspect](): string {
		return `PeerId(${this.toString()})`;
	}
}

export class Secp256k1PeerId
	extends PeerIdImpl<0x0>
	implements Secp256k1PeerId
{
	public override readonly type = "secp256k1";
	public declare readonly publicKey: Secp256k1PublicKey;

	constructor(init: Secp256k1PeerIdInit) {
		super({ ...init, type: "secp256k1" });

		this.publicKey = init.publicKey;
	}
}

export function peerIdFromPublicKey(
	publicKey: Secp256k1PublicKey,
): Secp256k1PeerId {
	return new Secp256k1PeerId({
		multihash: publicKey.toMultihash(),
		publicKey,
	});
}

export function peerIdFromPrivateKey(
	privateKey: Secp256k1PrivateKey,
): Secp256k1PeerId {
	return peerIdFromPublicKey(privateKey.publicKey);
}
