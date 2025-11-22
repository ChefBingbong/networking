// src/blockchain/p2p/sync.ts
import type { Block, Hash } from "../types";
import type { PeerNode } from "../../node/node";
import type { ChainState } from "../blockchain/chain";
import { validateAndAddBlock } from "../blockchain/chain";

export async function syncBlocks(
	node: PeerNode,
	peer: string,
	chain: ChainState,
): Promise<void> {
	// Request blocks from peer
	// Implementation would use protocol messages
}

export async function requestBlocks(
	node: PeerNode,
	peer: string,
	fromBlock: bigint,
): Promise<Block[]> {
	// Request blocks starting from fromBlock
	// Implementation would use protocol messages
	return [];
}

export async function processIncomingBlocks(
	node: PeerNode,
	blocks: Block[],
	chain: ChainState,
): Promise<number> {
	let added = 0;
	for (const block of blocks) {
		if (validateAndAddBlock(chain, block)) {
			added++;
		}
	}
	return added;
}

export function validateBlockChain(
	chain: ChainState,
	blocks: Block[],
): boolean {
	// Validate chain of blocks
	for (let i = 1; i < blocks.length; i++) {
		const prev = blocks[i - 1];
		const curr = blocks[i]!;
		if (curr.header.parentHash !== blockHash(prev)) {
			return false;
		}
		if (curr.header.number !== prev.header.number + 1n) {
			return false;
		}
	}
	return true;
}

import { blockHash } from "../block/block";

