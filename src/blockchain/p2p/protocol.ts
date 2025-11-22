// src/blockchain/p2p/protocol.ts
import type { Block, Hash, Transaction } from "../types";
import type { PeerNode } from "../../node/node";

export const BLOCKCHAIN_PROTOCOL = "/blockchain/1.0.0";

export type BlockchainMessage =
	| { type: "Status"; chainId: bigint; headHash: Hash; headNumber: bigint }
	| { type: "NewBlockHashes"; hashes: Hash[] }
	| { type: "GetBlocks"; hashes: Hash[] }
	| { type: "Blocks"; blocks: Block[] }
	| { type: "NewBlock"; block: Block }
	| { type: "GetBlockHeaders"; startHash: Hash; maxHeaders: number }
	| { type: "BlockHeaders"; headers: Block[] }
	| { type: "GetBlockBodies"; hashes: Hash[] }
	| { type: "BlockBodies"; blocks: Block[] }
	| { type: "NewPooledTransactionHashes"; hashes: Hash[] }
	| { type: "GetPooledTransactions"; hashes: Hash[] }
	| { type: "PooledTransactions"; transactions: Transaction[] };

export async function handleBlockchainMessage(
	node: PeerNode,
	msg: BlockchainMessage,
	from: string,
): Promise<BlockchainMessage | null> {
	// Protocol handler - to be implemented with actual blockchain client
	// For now, return null (no response)
	return null;
}

export async function sendStatus(
	node: PeerNode,
	to: string,
	chainId: bigint,
	headHash: Hash,
	headNumber: bigint,
): Promise<void> {
	const msg: BlockchainMessage = {
		type: "Status",
		chainId,
		headHash,
		headNumber,
	};
	// Send via protocol manager
	// await node.protocolManager.send(to, BLOCKCHAIN_PROTOCOL, msg);
}

export async function sendNewBlock(
	node: PeerNode,
	to: string,
	block: Block,
): Promise<void> {
	const msg: BlockchainMessage = {
		type: "NewBlock",
		block,
	};
	// Send via protocol manager
	// await node.protocolManager.send(to, BLOCKCHAIN_PROTOCOL, msg);
}

export async function sendBlocks(
	node: PeerNode,
	to: string,
	blocks: Block[],
): Promise<void> {
	const msg: BlockchainMessage = {
		type: "Blocks",
		blocks,
	};
	// Send via protocol manager
	// await node.protocolManager.send(to, BLOCKCHAIN_PROTOCOL, msg);
}

