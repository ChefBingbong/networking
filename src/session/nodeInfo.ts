import type { KeyType } from "../secp256k1/keys";
import type { Secp256k1PublicKey } from "../secp256k1/secp256k1";

export type PeerIdType = KeyType | string;
export interface NodeInfo {
	name: string;

	version: string;
}
export interface Secp256k1PeerId {
	readonly type: "secp256k1";
	readonly publicKey: Secp256k1PublicKey;
	toString(): string;
	equals(other?: any): boolean;
}

export type PeerId = Secp256k1PeerId;

export const peerIdSymbol = Symbol.for("p2p/peer-id");

export function isPeerId(other?: any): other is PeerId {
	return Boolean(other?.[peerIdSymbol]);
}
