// src/blockchain/block/header.ts
import type { Address, BlockHeader, ChainConfig, Hash } from "../types";
import {
	bytesToBigInt,
	hashToHex,
	rlpDecode,
	blockHash as utilsBlockHash,
	headerToRLP as utilsHeaderToRLP,
	validateBlockHeader as validateHeaderUtil,
} from "../utils";

export function createHeader(fields: Partial<BlockHeader>): BlockHeader {
	return {
		parentHash:
			fields.parentHash ??
			("0x0000000000000000000000000000000000000000000000000000000000000000" as Hash),
		ommersHash:
			fields.ommersHash ??
			("0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347" as Hash),
		beneficiary:
			fields.beneficiary ??
			("0x0000000000000000000000000000000000000000" as Address),
		stateRoot:
			fields.stateRoot ??
			("0x0000000000000000000000000000000000000000000000000000000000000000" as Hash),
		transactionsRoot:
			fields.transactionsRoot ??
			("0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash),
		receiptsRoot:
			fields.receiptsRoot ??
			("0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421" as Hash),
		logsBloom: fields.logsBloom ?? new Uint8Array(256).fill(0),
		difficulty: fields.difficulty ?? 0n,
		number: fields.number ?? 0n,
		gasLimit: fields.gasLimit ?? 0n,
		gasUsed: fields.gasUsed ?? 0n,
		timestamp: fields.timestamp ?? BigInt(Math.floor(Date.now() / 1000)),
		extraData: fields.extraData ?? new Uint8Array(0),
		mixHash:
			fields.mixHash ??
			("0x0000000000000000000000000000000000000000000000000000000000000000" as Hash),
		nonce: fields.nonce ?? 0n,
	};
}

export function headerToRLP(header: BlockHeader): Uint8Array {
	return utilsHeaderToRLP(header);
}

export function headerFromRLP(data: Uint8Array): BlockHeader {
	const decoded = rlpDecode(data) as Uint8Array[];

	if (!Array.isArray(decoded)) {
		console.error(
			"[headerFromRLP] Decoded data is not an array:",
			typeof decoded,
			decoded,
		);
		throw new Error("Invalid header RLP data: not an array");
	}

	if (decoded.length < 15) {
		console.error(
			`[headerFromRLP] Invalid header RLP data: expected 15 fields, got ${decoded.length}`,
		);
		console.error("[headerFromRLP] Data length:", data.length);
		console.error(
			"[headerFromRLP] First 100 bytes:",
			Buffer.from(data.slice(0, 100)).toString("hex"),
		);
		throw new Error(
			`Invalid header RLP data: expected 15 fields, got ${decoded.length}`,
		);
	}

	return {
		parentHash: hashToHex(decoded[0]!) as Hash,
		ommersHash: hashToHex(decoded[1]!) as Hash,
		beneficiary: hashToHex(decoded[2]!.slice(-20)) as Address, // Address is 20 bytes
		stateRoot: hashToHex(decoded[3]!) as Hash,
		transactionsRoot: hashToHex(decoded[4]!) as Hash,
		receiptsRoot: hashToHex(decoded[5]!) as Hash,
		logsBloom: decoded[6]!,
		difficulty: bytesToBigInt(decoded[7]!),
		number: bytesToBigInt(decoded[8]!),
		gasLimit: bytesToBigInt(decoded[9]!),
		gasUsed: bytesToBigInt(decoded[10]!),
		timestamp: bytesToBigInt(decoded[11]!),
		extraData: decoded[12]!,
		mixHash: hashToHex(decoded[13]!) as Hash,
		nonce: bytesToBigInt(decoded[14]!),
	};
}

export function headerHash(header: BlockHeader): Hash {
	return utilsBlockHash(header);
}

export function validateHeader(
	header: BlockHeader,
	parent?: BlockHeader,
	chainConfig?: ChainConfig,
): boolean {
	return validateHeaderUtil(header, parent);
}
