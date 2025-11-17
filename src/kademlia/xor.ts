// src/kademlia/xor.ts
import { createHash } from "crypto";

/**
 * Size of the keyspace in bits (sha256 => 256 bits).
 * Mirrors NUM_BUCKETS in the Chainsafe code.
 */
export const NUM_BUCKETS = 256;

/**
 * Hash a PeerId (or arbitrary string) into a fixed 256-bit keyspace.
 */
export function idToKey(id: string): Buffer {
	return createHash("sha256").update(id).digest(); // 32 bytes
}

/**
 * XOR distance between two ids, returned as Buffer.
 * (Still returns Buffer for compatibility with existing code.)
 */
export function xorDistance(a: string, b: string): Buffer {
	const ak = idToKey(a);
	const bk = idToKey(b);

	if (ak.length !== bk.length) {
		throw new Error(
			`xorDistance: key length mismatch a=${ak.length}, b=${bk.length}`,
		);
	}

	const out = Buffer.alloc(ak.length);
	for (let i = 0; i < ak.length; i++) {
		out[i] = ak[i]! ^ bk[i]!;
	}
	return out;
}

/**
 * Optional: XOR distance as a bigint (similar to Chainsafe's `distance`).
 */
export function xorDistanceBigint(a: string, b: string): bigint {
	const dist = xorDistance(a, b);
	let result = 0n;
	for (let i = 0; i < dist.length; i++) {
		result = (result << 8n) | BigInt(dist[i]!);
	}
	return result;
}

/**
 * Count leading zero bits in a distance buffer.
 * This is the byte-based analogue of the Chainsafe hex-nibble loop.
 */
function leadingZeroBits(dist: Buffer): number {
	if (dist.length * 8 !== NUM_BUCKETS) {
		throw new Error(
			`leadingZeroBits: expected ${NUM_BUCKETS / 8} bytes, got ${dist.length}`,
		);
	}

	let firstMatch = 0; // number of leading zero bits in the XOR

	for (let i = 0; i < dist.length; i++) {
		const byte = dist[i]!;
		if (byte === 0) {
			// whole byte is zero => 8 more matching bits
			firstMatch += 8;
			continue;
		}

		// High nibble (bits 7..4)
		const hi = (byte >> 4) & 0x0f;
		if (hi !== 0) {
			if (hi & 0b1000) {
				firstMatch += 0;
			} else if (hi & 0b0100) {
				firstMatch += 1;
			} else if (hi & 0b0010) {
				firstMatch += 2;
			} else if (hi & 0b0001) {
				firstMatch += 3;
			}
			break;
		} else {
			firstMatch += 4;
		}

		// Low nibble (bits 3..0)
		const lo = byte & 0x0f;
		if (lo !== 0) {
			if (lo & 0b1000) {
				firstMatch += 4;
			} else if (lo & 0b0100) {
				firstMatch += 5;
			} else if (lo & 0b0010) {
				firstMatch += 6;
			} else if (lo & 0b0001) {
				firstMatch += 7;
			}
			break;
		} else {
			firstMatch += 4;
		}
	}

	return firstMatch; // in [0, NUM_BUCKETS]
}

/**
 * Chainsafe-style log2 distance:
 *
 *  - 0      if ids are identical
 *  - 1..256 otherwise, where larger = further in XOR space
 */
export function log2Distance(a: string, b: string): number {
	const dist = xorDistance(a, b); // xor buffer
	const leadingZeros = leadingZeroBits(dist);
	// identical => leadingZeros = NUM_BUCKETS => distance = 0
	return NUM_BUCKETS - leadingZeros;
}

/**
 * Calculates the log2 distances around the "true" distance,
 * like Chainsafe's `findNodeLog2Distances`.
 */
export function findNodeLog2Distances(
	a: string,
	b: string,
	size: number,
): number[] {
	if (size <= 0) {
		throw new Error("Iterations must be greater than 0");
	}
	if (size > 127) {
		throw new Error("Iterations cannot be greater than 127");
	}

	let d = log2Distance(a, b);
	if (d === 0) {
		d = 1;
	}

	const results = [d];
	let difference = 1;

	while (results.length < size) {
		if (d + difference <= NUM_BUCKETS) {
			results.push(d + difference);
		}
		if (d - difference > 0) {
			results.push(d - difference);
		}
		difference += 1;
	}

	return results.slice(0, size);
}

/**
 * Map a distance buffer to a bucket index.
 *
 * Your *existing* semantics were:
 *   - Scan from MSB to LSB, find first non-zero bit in XOR
 *   - Return that bit index in [0..255], or 0 if all zeros
 *
 * Here we compute the same thing via `leadingZeroBits`:
 *   - `leadingZeroBits` == number of equal prefix bits
 *   - that *is* exactly the old `bitIndex`
 *
 * So:
 *   - farthest peers => index ~0
 *   - closer peers    => larger index
 *   - identical peers => we keep returning 0 for compatibility
 */
export function bucketIndexForDistance(dist: Buffer): number {
	const leadingZeros = leadingZeroBits(dist);

	if (leadingZeros === NUM_BUCKETS) {
		// identical ids: keep old behaviour (bucket 0)
		return 0;
	}

	// Same meaning as your previous implementation:
	// 0..255 = "how many bits of prefix are equal"
	return leadingZeros;
}
