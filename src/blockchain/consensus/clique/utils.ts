// src/blockchain/consensus/clique/utils.ts
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256 } from "ethereum-cryptography/keccak";
import { headerToArray } from "../../block/header";
import type { Address, BlockHeader } from "../../types";
import {
	addressFromPrivateKey,
	hashToHex,
	keccak256Hash,
	rlpEncode,
} from "../../utils";

/**
 * Extract signer address from block header extraData
 * In Clique, the signer's signature is stored in the last 65 bytes of extraData
 */
export function cliqueSigner(header: BlockHeader): Address {
	if (header.extraData.length < 65) {
		throw new Error("Invalid Clique header: extraData too short");
	}

	// Extract signature (last 65 bytes)
	const signature = header.extraData.slice(-65);

	// Recover signer from signature
	// The signed data is the RLP-encoded header without the signature
	const headerWithoutSig = {
		...header,
		extraData: header.extraData.slice(0, -65),
	};

	// Create hash of header (without signature)
	const headerHash = keccak256(headerToRLPForSigning(headerWithoutSig));
	console.log(
		`[cliqueSigner] Recovering from header #${header.number}, extraData length: ${headerWithoutSig.extraData.length}, headerHash: ${Buffer.from(headerHash).toString("hex").slice(0, 16)}...`,
	);

	// Extract r, s, v from signature
	const r = signature.slice(0, 32);
	const s = signature.slice(32, 64);
	const v = signature[64]!;

	// Create compact signature (64 bytes: 32 bytes r + 32 bytes s)
	const compactSig = new Uint8Array(64);
	compactSig.set(r, 0);
	compactSig.set(s, 32);

	// Recovery bit: v - 27 (Clique uses standard recovery, not EIP-155)
	const recovery = v - 27;
	if (recovery < 0 || recovery > 3) {
		throw new Error(`Invalid recovery bit: ${v}`);
	}

	// Recover public key
	const signatureObj =
		secp256k1.Signature.fromCompact(compactSig).addRecoveryBit(recovery);
	const recoveredPubKey = signatureObj.recoverPublicKey(headerHash);

	// Get uncompressed public key (toRawBytes(false) gives uncompressed)
	const publicKey = recoveredPubKey.toRawBytes(true);

	// Derive address: keccak256(publicKey[1:])[12:]
	// Remove first byte (0x04 for uncompressed) and take last 20 bytes
	const publicKeyWithoutPrefix = publicKey.slice(1);
	const addressHash = keccak256Hash(publicKeyWithoutPrefix);
	return hashToHex(addressHash.slice(-20)) as Address;
}

/**
 * Verify Clique block signature
 */
export function cliqueVerifySignature(
	header: BlockHeader,
	signers: Address[],
): boolean {
	try {
		const signer = cliqueSigner(header);
		return signers.some((addr) => addr.toLowerCase() === signer.toLowerCase());
	} catch {
		return false;
	}
}

/**
 * Check if block is an epoch transition block
 */
export function cliqueIsEpochTransition(
	header: BlockHeader,
	epoch: number,
): boolean {
	return Number(header.number) % epoch === 0;
}

/**
 * Extract signers from epoch transition block extraData
 * Format: [vanity bytes (32)][signers (20 bytes each)][signature (65 bytes)]
 */
export function cliqueEpochTransitionSigners(
	header: BlockHeader,
	epoch: number,
): Address[] {
	if (!cliqueIsEpochTransition(header, epoch)) {
		return [];
	}

	// Remove signature (last 65 bytes) and vanity (first 32 bytes)
	const signersData = header.extraData.slice(32, -65);
	const signers: Address[] = [];

	for (let i = 0; i < signersData.length; i += 20) {
		const signerBytes = signersData.slice(i, i + 20);
		if (signerBytes.length === 20) {
			signers.push(hashToHex(signerBytes) as Address);
		}
	}

	return signers;
}

/**
 * Convert header to RLP for signing (without signature in extraData)
 */
function headerToRLPForSigning(header: BlockHeader): Uint8Array {
	const headerArray = headerToArray(header);
	return rlpEncode(headerArray);
}

/**
 * Sign a block header for Clique consensus
 * Returns header with signature appended to extraData
 *
 * The header passed should already have extraData set to the value without signature
 * (vanity + signers if epoch transition, or just vanity for normal blocks)
 */
export function signCliqueHeader(
	header: BlockHeader,
	privateKey: Uint8Array,
): BlockHeader {
	// Use the header as-is (it should already have extraData without signature)
	// Hash the header (without signature)
	const headerHash = keccak256(headerToRLPForSigning(header));
	console.log(
		`[signCliqueHeader] Signing header #${header.number}, extraData length: ${header.extraData.length}, headerHash: ${Buffer.from(headerHash).toString("hex").slice(0, 16)}...`,
	);

	// Sign the hash
	const signature = secp256k1.sign(headerHash, privateKey);

	// Extract r, s, recovery bit
	const r = signature.r;
	const s = signature.s;
	const recovery = signature.recovery ?? 0;

	// Debug: Verify the signer address matches
	const signerAddress = addressFromPrivateKey(privateKey);
	console.log(
		`[signCliqueHeader] Signing header #${header.number} with address: ${signerAddress}, recovery: ${recovery}`,
	);

	// Convert r and s to bytes (32 bytes each, big-endian)
	const rBytes = new Uint8Array(32);
	const sBytes = new Uint8Array(32);

	let rValue = r;
	let sValue = s;
	for (let i = 31; i >= 0; i--) {
		rBytes[i] = Number(rValue & 0xffn);
		sBytes[i] = Number(sValue & 0xffn);
		rValue = rValue >> 8n;
		sValue = sValue >> 8n;
	}

	// Create signature bytes: r (32) + s (32) + v (1)
	const signatureBytes = new Uint8Array(65);
	signatureBytes.set(rBytes, 0);
	signatureBytes.set(sBytes, 32);
	signatureBytes[64] = recovery + 27; // v = recovery + 27

	// Append signature to extraData
	const extraData = new Uint8Array(
		header.extraData.length + signatureBytes.length,
	);
	extraData.set(header.extraData, 0);
	extraData.set(signatureBytes, header.extraData.length);

	// Return header with updated extraData AND preserve all other fields from header
	// This ensures difficulty and other fields match what was signed
	return {
		...header,
		extraData,
	};
}
