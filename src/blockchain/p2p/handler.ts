// src/blockchain/p2p/handler.ts
import type { ProtocolStream } from "../../connection/protocol-stream";
import { blockHash } from "../block/block";
import {
	getBlock,
	getCanonicalHead,
	validateAndAddBlock,
} from "../blockchain/chain";
import type { BlockchainClientState } from "../client/client";
import type { Block } from "../types";
import { txHash } from "../utils";
import type { BlockchainMessage } from "./protocol";
import { addTransaction, getPendingTransactions } from "./tx-pool";

export function createBlockchainProtocolHandler(
	client: BlockchainClientState,
): (stream: ProtocolStream) => Promise<void> {
	return async (stream: ProtocolStream) => {
		try {
			// Send initial status
			const head = getCanonicalHead(client.chain);
			if (head) {
				const statusMsg: BlockchainMessage = {
					type: "Status",
					chainId: client.config.chainId,
					headHash: blockHash(head),
					headNumber: head.header.number,
				};
				stream.send(Buffer.from(JSON.stringify(statusMsg), "utf-8"));
			}

			// Listen for incoming messages
			stream.addEventListener("message", async (evt: { data: any }) => {
				try {
					const data = evt.data;
					const msg = JSON.parse(
						Buffer.from(data).toString("utf-8"),
					) as BlockchainMessage;

					// Extract peer info from stream connection
					const fromPeer =
						(stream.conn as any).remoteAddr?.toString() || "unknown";
					const response = await handleBlockchainMessageForClient(
						client,
						msg,
						fromPeer,
					);

					if (response) {
						stream.send(Buffer.from(JSON.stringify(response), "utf-8"));
					}
				} catch (err) {
					console.error("Error handling blockchain message:", err);
				}
			});

			// Keep stream alive
			stream.addEventListener("close", () => {
				// Stream closed
			});
		} catch (err) {
			console.error("Error in blockchain protocol handler:", err);
		}
	};
}

export async function handleBlockchainMessageForClient(
	client: BlockchainClientState,
	msg: BlockchainMessage,
	fromPeer?: string,
): Promise<BlockchainMessage | null> {
	// Track received message
	client.receivedMessages.push({
		timestamp: Date.now(),
		type: msg.type,
		from: fromPeer,
		data: msg,
	});

	// Keep only last 1000 messages
	if (client.receivedMessages.length > 1000) {
		client.receivedMessages.shift();
	}

	switch (msg.type) {
		case "Status": {
			// Handle status message - compare chains
			const head = getCanonicalHead(client.chain);
			if (!head) return null;

			if (msg.headNumber > head.header.number) {
				// Request blocks
				return {
					type: "GetBlocks",
					hashes: [blockHash(head)],
				};
			}
			return null;
		}

		case "GetBlocks": {
			// Send requested blocks
			const blocks: Block[] = [];
			for (const hash of msg.hashes) {
				const block = getBlock(client.chain, hash);
				if (block) {
					blocks.push(block);
				}
			}
			return {
				type: "Blocks",
				blocks,
			};
		}

		case "Blocks": {
			// Process incoming blocks
			for (const block of msg.blocks) {
				validateAndAddBlock(client.chain, block);
			}
			return null;
		}

		case "NewBlock": {
			// Process new block
			validateAndAddBlock(client.chain, msg.block);
			return null;
		}

		case "GetPooledTransactions": {
			// Send requested transactions
			const pending = getPendingTransactions(client.txPool);
			const requested = pending.filter((tx) => msg.hashes.includes(txHash(tx)));
			return {
				type: "PooledTransactions",
				transactions: requested,
			};
		}

		case "PooledTransactions": {
			// Add transactions to pool
			for (const tx of msg.transactions) {
				addTransaction(client.txPool, tx, client.stateManager);
			}
			return null;
		}

		default:
			return null;
	}
}
