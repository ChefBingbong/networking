// src/blockchain/p2p/handler.ts
import type { ProtocolStream } from "../../connection/protocol-stream";
import { parseWithBigInt, stringifyWithBigInt } from "../../utils/utils";
import { blockHash } from "../block/block";
import {
	getBlock,
	getCanonicalHead,
	validateAndAddBlock,
} from "../blockchain/chain";
import { processBlock } from "../blockchain/processor";
import type { BlockchainClientState } from "../client/client";
import type { Block, Transaction } from "../types";
import { txHash } from "../utils";
import {
	deserializeBlock,
	deserializeBlocks,
	serializeBlock,
	serializeBlocks,
} from "../utils/serialization";
import type { BlockchainMessage } from "./protocol";
import { BLOCKCHAIN_PROTOCOL } from "./protocol";
import { addTransaction, getPendingTransactions } from "./tx-pool";

export function createBlockchainProtocolHandler(
	client: BlockchainClientState,
): (stream: ProtocolStream) => Promise<void> {
	return async (stream: ProtocolStream) => {
		try {
			// Find peer address from connections map
			let fromPeer = "unknown";
			console.log(Array.from(client.node.connections.keys()), "connections");
			for (const [addr, conn] of client.node.connections.entries()) {
				if (conn === stream.conn) {
					fromPeer = addr;
					break;
				}
			}

			// Send initial status
			const head = getCanonicalHead(client.chain);
			if (head) {
				const statusMsg: BlockchainMessage = {
					type: "Status",
					chainId: client.config.chainId,
					headHash: blockHash(head),
					headNumber: head.header.number,
				};
				stream.send(Buffer.from(stringifyWithBigInt(statusMsg), "utf-8"));
			}

			// Listen for incoming messages
			stream.addEventListener("message", async (evt: { data: Uint8Array }) => {
				try {
					const data = evt.data;
					const msg = parseWithBigInt(
						Buffer.from(data).toString("utf-8"),
					) as BlockchainMessage;

					// Convert block JSON string back to Block object if it's a NewBlock message
					if (msg.type === "NewBlock" && typeof msg.block === "string") {
						const block = deserializeBlock(msg.block);
						// Create decoded message with Block object
						const decodedMsg = {
							type: "NewBlock" as const,
							block,
						};
						const response = await handleBlockchainMessageForClient(
							client,
							decodedMsg as unknown as BlockchainMessage,
							fromPeer,
						);
						if (response) {
							stream.send(Buffer.from(stringifyWithBigInt(response), "utf-8"));
						}
						return;
					}

					const response = await handleBlockchainMessageForClient(
						client,
						msg,
						fromPeer,
					);

					if (response) {
						stream.send(Buffer.from(stringifyWithBigInt(response), "utf-8"));
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
			// Serialize blocks to JSON string
			const blocksJson = serializeBlocks(blocks);
			return {
				type: "Blocks",
				blocks: blocksJson,
			};
		}

		case "Blocks": {
			// Deserialize blocks from JSON string
			const blocks = deserializeBlocks(msg.blocks);
			for (const block of blocks) {
				// Check if block extends canonical head before processing
				const currentHead = getCanonicalHead(client.chain);
				if (currentHead && block.header.parentHash !== blockHash(currentHead)) {
					console.log(
						`[handler] Block #${block.header.number.toString()} does not extend canonical head (${block.header.parentHash} !== ${blockHash(currentHead)}), skipping`,
					);
					continue;
				}

				const result = await validateAndAddBlock(
					client.chain,
					block,
					client.clique,
				);
				if (result) {
					// Only process if it extends canonical head
					const newHead = getCanonicalHead(client.chain);
					if (newHead && blockHash(block) === blockHash(newHead)) {
						// Process block to update state
						const processResult = processBlock(
							client.chain,
							block,
							client.stateManager,
						);
						if (processResult.success) {
							console.log(
								`[handler] Processed block #${block.header.number.toString()} from ${fromPeer}`,
							);
						} else {
							console.log(
								`[handler] Failed to process block #${block.header.number.toString()}`,
							);
							// Remove block from chain if processing failed
							client.chain.blocks.delete(blockHash(block));
							if (currentHead) {
								client.chain.canonicalHead = blockHash(currentHead);
							}
						}
					}
				}
			}
			return null;
		}

		case "NewBlock": {
			// Process new block - msg.block is Block object (decoded from hex string in handler)
			const block = (msg as unknown as { type: "NewBlock"; block: Block })
				.block;

			// Check if block extends canonical head before processing
			const currentHead = getCanonicalHead(client.chain);
			if (currentHead && block.header.parentHash !== blockHash(currentHead)) {
				console.log(
					`[handler] NewBlock #${block.header.number.toString()} does not extend canonical head (${block.header.parentHash} !== ${blockHash(currentHead)}), skipping`,
				);
				return null;
			}

			const result = await validateAndAddBlock(
				client.chain,
				block,
				client.clique,
			);
			if (result) {
				// Only process if it extends canonical head
				const newHead = getCanonicalHead(client.chain);
				if (newHead && blockHash(block) === blockHash(newHead)) {
					// Process block to update state
					const processResult = processBlock(
						client.chain,
						block,
						client.stateManager,
					);
					if (processResult.success) {
						console.log(
							`[handler] Processed new block #${block.header.number.toString()} from ${fromPeer}`,
						);

						// Broadcast to other peers (gossip)
						broadcastBlockToPeers(client, block, fromPeer);
					} else {
						console.log(
							`[handler] Failed to process new block #${block.header.number.toString()}`,
						);
						// Remove block from chain if processing failed
						client.chain.blocks.delete(blockHash(block));
						if (currentHead) {
							client.chain.canonicalHead = blockHash(currentHead);
						}
					}
				}
			}
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
			let added = 0;
			for (const tx of msg.transactions) {
				if (addTransaction(client.txPool, tx, client.stateManager)) {
					added++;
				}
			}
			if (added > 0) {
				console.log(`[handler] Added ${added} transactions from ${fromPeer}`);
				// Broadcast to other peers (gossip)
				broadcastTransactionsToPeers(client, msg.transactions, fromPeer);
			}
			return null;
		}

		default:
			return null;
	}
}

/**
 * Broadcast block to all connected peers (except sender)
 */
function broadcastBlockToPeers(
	client: BlockchainClientState,
	block: Block,
	excludePeer?: string,
): void {
	const peers = Array.from(client.node.connections.keys()).filter(
		(addr) => addr !== excludePeer,
	);

	console.log(peers, "broadcastBlockToPeers");
	if (peers.length === 0) return;

	// Serialize block to JSON string
	const blockJson = serializeBlock(block);

	const msg: BlockchainMessage = {
		type: "NewBlock",
		block: blockJson,
	};

	for (const peerAddr of peers) {
		const conn = client.node.connections.get(peerAddr);
		if (!conn) continue;

		client.node.protocolManager
			.initOutgoing(conn, BLOCKCHAIN_PROTOCOL)
			.then((stream) => {
				stream.send(Buffer.from(stringifyWithBigInt(msg), "utf-8"));
				setTimeout(() => {
					try {
						stream.close();
					} catch {}
				}, 1000);
			})
			.catch(() => {
				// Ignore errors
			});
	}
}

/**
 * Broadcast transactions to all connected peers (except sender)
 */
function broadcastTransactionsToPeers(
	client: BlockchainClientState,
	txs: Transaction[],
	excludePeer?: string,
): void {
	const peers = Array.from(client.node.connections.keys()).filter(
		(addr) => addr !== excludePeer,
	);

	if (peers.length === 0 || txs.length === 0) return;

	const msg: BlockchainMessage = {
		type: "PooledTransactions",
		transactions: txs,
	};

	for (const peerAddr of peers) {
		const conn = client.node.connections.get(peerAddr);
		if (!conn) continue;

		client.node.protocolManager
			.initOutgoing(conn, BLOCKCHAIN_PROTOCOL)
			.then((stream) => {
				stream.send(Buffer.from(stringifyWithBigInt(msg), "utf-8"));
				setTimeout(() => {
					try {
						stream.close();
					} catch {}
				}, 1000);
			})
			.catch(() => {
				// Ignore errors
			});
	}
}
