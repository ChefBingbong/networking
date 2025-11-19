// src/kademlia/xor.ts
import { createHash } from "crypto";

/**
 * Hash a PeerId (or arbitrary string) into a fixed 256-bit keyspace.
 */
export function idToKey(id: string): Buffer {
	return createHash("sha256").update(id).digest(); // 32 bytes
}

/**
 * XOR distance between two ids, returned as Buffer.
 */
export function xorDistance(a: string, b: string): Buffer {
	const ak = idToKey(a);
	const bk = idToKey(b);
	const out = Buffer.alloc(ak.length);
	for (let i = 0; i < ak.length; i++) {
		out[i] = ak[i]! ^ bk[i]!;
	}
	return out;
}

/**
 * Return the bucket index based on the distance buffer.
 * We use the index of the first non-zero bit (0..255). If all zeros (same id),
 * return 0.
 */
export function bucketIndexForDistance(dist: Buffer): number {
	for (let byteIndex = 0; byteIndex < dist.length; byteIndex++) {
		const byte = dist[byteIndex]!;
		if (byte === 0) continue;
		// find first set bit in this byte (MSB first)
		for (let bit = 7; bit >= 0; bit--) {
			if (byte & (1 << bit)) {
				const bitIndex = byteIndex * 8 + (7 - bit);
				return bitIndex;
			}
		}
	}
	return 0; // identical -> bucket 0
}
