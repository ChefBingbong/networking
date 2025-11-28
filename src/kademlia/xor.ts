// src/kademlia/xor.ts
// XOR distance calculations for Kademlia DHT

import { keccak256 } from 'ethereum-cryptography/keccak.js'
import { bytesToUnprefixedHex, concatBytes } from '../utils'

/**
 * XOR two Uint8Arrays of potentially different lengths.
 */
export function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const length = Math.min(a.length, b.length)
  const result = new Uint8Array(length)
  for (let i = 0; i < length; ++i) {
    result[i] = a[i] ^ b[i]
  }
  return result
}

/**
 * Calculate XOR distance between two node IDs.
 * Returns a number representing the distance (suitable for sorting).
 * 
 * This matches the k-bucket distance function for compatibility.
 */
export function xorDistance(firstId: Uint8Array, secondId: Uint8Array): number {
  let distance = 0
  const min = Math.min(firstId.length, secondId.length)
  const max = Math.max(firstId.length, secondId.length)
  
  for (let i = 0; i < min; ++i) {
    distance = distance * 256 + (firstId[i] ^ secondId[i])
  }
  for (let i = min; i < max; ++i) {
    distance = distance * 256 + 255
	}

  return distance
}

/**
 * Calculate XOR distance as a bigint for very precise comparisons.
 */
export function xorDistanceBigInt(a: Uint8Array, b: Uint8Array): bigint {
  const xored = xor(a, b)
  if (xored.length === 0) return 0n
  return BigInt('0x' + bytesToUnprefixedHex(xored))
}

/**
 * Get the bit length of a bigint (position of highest set bit).
 */
function bitLength(n: bigint): number {
  let bits = 0
	while (n > 0n) {
    n >>= 1n
    bits++
	}
  return bits
}

/**
 * Calculate bucket index for a given XOR distance.
 * Bucket i stores nodes whose distance is in [2^i, 2^(i+1)).
 */
export function bucketIndexFromDistance(dist: bigint, idBits = 512): number {
  if (dist === 0n) return 0

  const len = bitLength(dist)
  const idx = len - 1

  if (idx < 0) return 0
  if (idx >= idBits) return idBits - 1
  return idx
}

/**
 * Calculate bucket index between two node IDs.
 */
export function bucketIndex(selfId: Uint8Array, otherId: Uint8Array, idBits = 512): number {
  const dist = xorDistanceBigInt(selfId, otherId)
  return bucketIndexFromDistance(dist, idBits)
}

/**
 * Hash a string ID into a fixed-size key using keccak256.
 * This is useful for converting human-readable IDs into node IDs.
 */
export function hashToId(data: string | Uint8Array): Uint8Array {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return keccak256(input)
}

/**
 * Convert a public key (with 0x04 prefix) to a node ID (without prefix).
 * Node IDs in Ethereum are the 64-byte uncompressed public key without the prefix.
 */
export function pk2id(pk: Uint8Array): Uint8Array {
  if (pk.length === 33) {
    // Compressed public key - need to decompress
 return pk
  }
  if (pk.length === 65) {
    // Remove the 0x04 prefix
    return pk.subarray(1)
  }
  if (pk.length === 64) {
    // Already a node ID
    return pk
  }
  throw new Error(`Invalid public key length: ${pk.length}`)
}

/**
 * Convert a node ID back to a public key (add 0x04 prefix).
 */
export function id2pk(id: Uint8Array): Uint8Array {
  if (id.length !== 64) {
    throw new Error(`Invalid node ID length: ${id.length}, expected 64`)
  }
  return concatBytes(Uint8Array.from([0x04]), id)
}

/**
 * Zero-pad or truncate bytes to a specific size.
 */
export function zfill(bytes: Uint8Array, size: number, leftpad = true): Uint8Array {
  if (bytes.length >= size) return bytes.subarray(0, size)
  
  const pad = new Uint8Array(size - bytes.length).fill(0x00)
  return leftpad ? concatBytes(pad, bytes) : concatBytes(bytes, pad)
}

// Re-export for backward compatibility
export { xorDistance as distance }
