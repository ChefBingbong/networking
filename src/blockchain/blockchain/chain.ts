// src/blockchain/blockchain/chain.ts

import { blockHash, validateBlock } from "../block/block";
import { validateHeader } from "../block/header";
import type { CliqueConsensusState } from "../consensus/clique";
import {
	cliqueBuildSnapshots,
	validateCliqueConsensus,
	validateCliqueDifficulty,
} from "../consensus/clique";
import type { Block, BlockHeader, ChainConfig, Hash } from "../types";

export interface ChainState {
	blocks: Map<Hash, Block>;
	headers: Map<Hash, BlockHeader>;
	blockByNumber: Map<bigint, Hash>;
	canonicalHead: Hash;
	genesis: Block;
	config: ChainConfig;
}

export function createChain(genesis: Block, config: ChainConfig): ChainState {
	const genesisHash = blockHash(genesis);
	const chain: ChainState = {
		blocks: new Map(),
		headers: new Map(),
		blockByNumber: new Map(),
		canonicalHead: genesisHash,
		genesis,
		config,
	};

	// Add genesis block
	chain.blocks.set(genesisHash, genesis);
	chain.headers.set(genesisHash, genesis.header);
	chain.blockByNumber.set(0n, genesisHash);

	return chain;
}

export function putBlock(chain: ChainState, block: Block): void {
	const hash = blockHash(block);
	chain.blocks.set(hash, block);
	chain.headers.set(hash, block.header);
	chain.blockByNumber.set(block.header.number, hash);
}

export function getBlock(
	chain: ChainState,
	hashOrNumber: Hash | bigint,
): Block | undefined {
	if (typeof hashOrNumber === "bigint") {
		const hash = chain.blockByNumber.get(hashOrNumber);
		if (!hash) return undefined;
		return chain.blocks.get(hash);
	}
	return chain.blocks.get(hashOrNumber);
}

export function getHeader(
	chain: ChainState,
	hashOrNumber: Hash | bigint,
): BlockHeader | undefined {
	if (typeof hashOrNumber === "bigint") {
		const hash = chain.blockByNumber.get(hashOrNumber);
		if (!hash) return undefined;
		return chain.headers.get(hash);
	}
	return chain.headers.get(hashOrNumber);
}

export function getCanonicalHead(chain: ChainState): Block | undefined {
	return chain.blocks.get(chain.canonicalHead);
}

export async function validateAndAddBlock(
	chain: ChainState,
	block: Block,
	clique?: CliqueConsensusState,
): Promise<boolean> {
	// Get parent
	const parent = getHeader(chain, block.header.parentHash);
	if (!parent && block.header.number !== 0n) {
		console.log(
			`[validateAndAddBlock] No parent found for block ${block.header.number.toString()}`,
		);
		return false;
	}

	// Validate block
	if (!validateBlock(block, parent, chain.config)) {
		console.log(
			`[validateAndAddBlock] Block validation failed for block ${block.header.number.toString()}`,
		);
		return false;
	}

	// Validate header
	if (!validateHeader(block.header, parent, chain.config)) {
		console.log(
			`[validateAndAddBlock] Header validation failed for block ${block.header.number.toString()}`,
		);
		return false;
	}

	// Validate Clique consensus if configured
	if (clique && chain.config.clique) {
		try {
			await validateCliqueConsensus(clique, block);
			await validateCliqueDifficulty(clique, block.header);
		} catch (err: any) {
			console.log(
				`[validateAndAddBlock] Clique validation error: ${err.message}`,
			);
			return false;
		}
	}

	// Check if block number is sequential
	if (parent && block.header.number !== parent.number + 1n) {
		console.log(
			`[validateAndAddBlock] Block number not sequential: expected ${(parent.number + 1n).toString()}, got ${block.header.number.toString()}`,
		);
		return false;
	}

	// Add block
	putBlock(chain, block);

	// Update canonical head if this block is on the longest chain
	if (
		!parent ||
		block.header.number > getHeader(chain, chain.canonicalHead)!.number
	) {
		chain.canonicalHead = blockHash(block);
	}

	// Update Clique snapshots if configured
	if (clique && chain.config.clique) {
		await cliqueBuildSnapshots(clique, block.header);
	}

	return true;
}
