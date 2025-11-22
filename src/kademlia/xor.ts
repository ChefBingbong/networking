// src/kademlia/xor.ts
import { createHash } from "crypto";
import type { NodeId } from "./types";

// For your toy example, set this to 4.
// For a real network, you’d use 160 or 256, etc.
const DEFAULT_ID_BITS = 160;

function charsForBits(idBits: number): number {
	if (idBits % 4 !== 0) {
		throw new Error(`idBits must be a multiple of 4, got ${idBits}`);
	}
	return idBits / 4;
}

export function idToKey(id: string, idBits: number = DEFAULT_ID_BITS): string {
	return createHash("sha1").update(id).digest().toString("hex", 0, idBits); // 32 bytes
}

/**
 * Normalise a hex string to a given bit-length:
 *  - strip 0x prefix
 *  - ensure it's hex
 *  - pad with leading zeros or truncate to the rightmost bits
 */
function normalizeHexId(id: string, idBits: number = DEFAULT_ID_BITS): string {
	let hex = id.toLowerCase().replace(/^0x/, "");

	if (!/^[0-9a-f]*$/.test(hex)) {
		throw new Error(`NodeId must be hex; got: ${id}`);
	}

	const neededChars = charsForBits(idBits);

	if (hex.length > neededChars) {
		// keep the least significant bits
		hex = hex.slice(hex.length - neededChars);
	} else if (hex.length < neededChars) {
		hex = hex.padStart(neededChars, "0");
	}

	return hex;
}

/**
 * Hash an arbitrary ID into a fixed-size keyspace.
 * idBits = number of bits in the keyspace (4, 16, 160, 256...)
 */

/**
 * XOR distance in the Kademlia metric.
 */
export function xorDist(
	a: NodeId,
	b: NodeId,
	idBits: number = DEFAULT_ID_BITS,
): bigint {
	const aBig = BigInt("0x" + idToKey(a, idBits));
	const bBig = BigInt("0x" + idToKey(b, idBits));
	return aBig ^ bBig;
}

function bitLength(n: bigint): number {
	let bits = 0;
	while (n > 0n) {
		n >>= 1n;
		bits++;
	}
	return bits;
}

/**
 * Bucket index as in the Kademlia paper.
 *
 * For ID_BITS, we have buckets 0..ID_BITS-1.
 * Bucket i stores nodes whose distance is in [2^i, 2^(i+1)).
 */
export function bucketIndex(
	selfId: NodeId,
	otherId: NodeId,
	idBits: number = DEFAULT_ID_BITS,
): number {
	const d = xorDist(selfId, otherId, idBits);
	if (d === 0n) return 0; // self

	const len = bitLength(d); // 1..idBits
	const idx = len - 1; // 0..idBits-1

	if (idx < 0) return 0;
	if (idx >= idBits) return idBits - 1;
	return idx;
}

/**
 * If you already have a distance, convert to bucket index.
 */
export function bucketIndexFromDistance(
	dist: bigint,
	idBits: number = DEFAULT_ID_BITS,
): number {
	if (dist === 0n) return 0;

	const len = bitLength(dist);
	const idx = len - 1;

	if (idx < 0) return 0;
	if (idx >= idBits) return idBits - 1;
	return idx;
}
