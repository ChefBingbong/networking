// scripts/test-keys.ts

import { randomBytes } from "crypto";
import { Secp256k1PrivateKey } from "../src/secp256k1/secp256k1";

export async function generateTestPrivateKey(
	_index: number,
): Promise<Secp256k1PrivateKey> {
	// This is pseudocode – replace with your actual key constructor / factory
	const seed = randomBytes(32);
	// e.g. return Secp256k1PrivateKey.fromSeed(seed);
	return new Secp256k1PrivateKey(seed);
}
