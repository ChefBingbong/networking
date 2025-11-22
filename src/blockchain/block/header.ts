// src/blockchain/block/header.ts
import type { BlockHeader, Hash, Address, ChainConfig } from "../types";
import {
	headerToRLP as utilsHeaderToRLP,
	blockHash as utilsBlockHash,
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
		beneficiary: fields.beneficiary ?? ("0x0000000000000000000000000000000000000000" as Address),
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
	// Simplified - full RLP decode implementation needed
	throw new Error("headerFromRLP not fully implemented");
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

