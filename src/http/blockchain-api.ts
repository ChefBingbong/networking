// src/http/blockchain-api.ts
import type { Hono } from "hono";
import type { BlockchainClientState } from "../blockchain/client/client";
import {
	getBlock,
	getCanonicalHead,
	getHeader,
} from "../blockchain/blockchain/chain";
import { blockHash } from "../blockchain/block/block";
import { getAccount } from "../blockchain/state/state-manager";
import { getPendingTransactions } from "../blockchain/p2p/tx-pool";
import { txHash } from "../blockchain/utils";
import type { Address, Hash } from "../blockchain/types";

export function addBlockchainApiRoutes(
	app: Hono,
	client: BlockchainClientState,
): void {
	// Chain info
	app.get("/blockchain/info", (c) => {
		const head = getCanonicalHead(client.chain);
		return c.json({
			chainId: client.config.chainId.toString(),
			chainName: client.config.name,
			headHash: head ? blockHash(head) : null,
			headNumber: head ? head.header.number.toString() : "0",
			blockCount: client.chain.blocks.size,
			syncing: client.syncing,
			minerAddress: client.minerAddress,
		});
	});

	// Get block by hash or number
	app.get("/blockchain/block/:identifier", (c) => {
		const identifier = c.req.param("identifier");
		
		let block;
		if (identifier.startsWith("0x")) {
			// Hash
			block = getBlock(client.chain, identifier as Hash);
		} else {
			// Number
			const blockNumber = BigInt(identifier);
			block = getBlock(client.chain, blockNumber);
		}

		if (!block) {
			return c.json({ error: "Block not found" }, 404);
		}

		return c.json({
			hash: blockHash(block),
			number: block.header.number.toString(),
			parentHash: block.header.parentHash,
			timestamp: block.header.timestamp.toString(),
			difficulty: block.header.difficulty.toString(),
			gasLimit: block.header.gasLimit.toString(),
			gasUsed: block.header.gasUsed.toString(),
			beneficiary: block.header.beneficiary,
			stateRoot: block.header.stateRoot,
			transactionsRoot: block.header.transactionsRoot,
			receiptsRoot: block.header.receiptsRoot,
			nonce: block.header.nonce.toString(),
			transactionCount: block.transactions.length,
			transactions: block.transactions.map((tx) => ({
				hash: txHash(tx),
				from: null, // Would need to recover sender
				to: tx.to,
				value: tx.value.toString(),
				gasLimit: tx.gasLimit.toString(),
				gasPrice: tx.type === "legacy" ? tx.gasPrice?.toString() : null,
				maxFeePerGas: tx.type === "eip1559" ? tx.maxFeePerGas?.toString() : null,
				nonce: tx.nonce.toString(),
			})),
		});
	});

	// Get latest blocks
	app.get("/blockchain/blocks", (c) => {
		const limitParam = c.req.query("limit");
		const limit = limitParam ? Number.parseInt(limitParam, 10) : 10;

		const head = getCanonicalHead(client.chain);
		if (!head) {
			return c.json({ blocks: [] });
		}

		const blocks = [];
		let currentBlock = head;
		let count = 0;

		while (currentBlock && count < limit) {
			blocks.push({
				hash: blockHash(currentBlock),
				number: currentBlock.header.number.toString(),
				timestamp: currentBlock.header.timestamp.toString(),
				gasUsed: currentBlock.header.gasUsed.toString(),
				transactionCount: currentBlock.transactions.length,
			});

			if (currentBlock.header.number === 0n) break;
			
			const parent = getBlock(client.chain, currentBlock.header.parentHash);
			if (!parent) break;
			
			currentBlock = parent;
			count++;
		}

		return c.json({ blocks });
	});

	// Get transaction by hash
	app.get("/blockchain/tx/:hash", (c) => {
		const hash = c.req.param("hash") as Hash;

		// Search through all blocks
		for (const block of client.chain.blocks.values()) {
			for (const tx of block.transactions) {
				if (txHash(tx) === hash) {
					return c.json({
						hash: txHash(tx),
						blockHash: blockHash(block),
						blockNumber: block.header.number.toString(),
						from: null, // Would need to recover sender
						to: tx.to,
						value: tx.value.toString(),
						gasLimit: tx.gasLimit.toString(),
						gasPrice: tx.type === "legacy" ? tx.gasPrice?.toString() : null,
						maxFeePerGas: tx.type === "eip1559" ? tx.maxFeePerGas?.toString() : null,
						nonce: tx.nonce.toString(),
						data: `0x${Buffer.from(tx.data).toString("hex")}`,
					});
				}
			}
		}

		return c.json({ error: "Transaction not found" }, 404);
	});

	// Get account balance
	app.get("/blockchain/balance/:address", (c) => {
		const address = c.req.param("address") as Address;
		const account = getAccount(client.stateManager, address);
		return c.json({
			address,
			balance: account.balance.toString(),
			nonce: account.nonce.toString(),
		});
	});

	// Get account info
	app.get("/blockchain/account/:address", (c) => {
		const address = c.req.param("address") as Address;
		const account = getAccount(client.stateManager, address);
		return c.json({
			address,
			balance: account.balance.toString(),
			nonce: account.nonce.toString(),
			codeHash: account.codeHash,
			storageRoot: account.storageRoot,
		});
	});

	// Get pending transactions
	app.get("/blockchain/pending", (c) => {
		const pending = getPendingTransactions(client.txPool);
		return c.json({
			count: pending.length,
			transactions: pending.map((tx) => ({
				hash: txHash(tx),
				to: tx.to,
				value: tx.value.toString(),
				gasLimit: tx.gasLimit.toString(),
				gasPrice: tx.type === "legacy" ? tx.gasPrice?.toString() : null,
				nonce: tx.nonce.toString(),
			})),
		});
	});

	// Debug endpoints
	app.get("/blockchain/debug/chain", (c) => {
		const head = getCanonicalHead(client.chain);
		const blocks = Array.from(client.chain.blocks.values()).map((block) => ({
			hash: blockHash(block),
			number: block.header.number.toString(),
			parentHash: block.header.parentHash,
			timestamp: block.header.timestamp.toString(),
			txCount: block.transactions.length,
		}));

		return c.json({
			chainId: client.config.chainId.toString(),
			headHash: head ? blockHash(head) : null,
			headNumber: head ? head.header.number.toString() : "0",
			totalBlocks: client.chain.blocks.size,
			blocks: blocks.sort((a, b) => 
				Number.parseInt(b.number) - Number.parseInt(a.number)
			),
		});
	});

	app.get("/blockchain/debug/state", (c) => {
		const accounts = Array.from(client.stateManager.accounts.entries()).map(
			([address, account]) => ({
				address,
				balance: account.balance.toString(),
				nonce: account.nonce.toString(),
			}),
		);

		return c.json({
			accountCount: client.stateManager.accounts.size,
			accounts,
		});
	});

	app.get("/blockchain/debug/p2p", (c) => {
		const peers = client.node.connections.size;
		const protocols = Array.from(client.node.protocolManager["handlers"].keys());
		
		return c.json({
			peerCount: peers,
			blockchainProtocol: protocols.includes("/blockchain/1.0.0"),
			syncing: client.syncing,
			minerAddress: client.minerAddress,
		});
	});

	app.get("/blockchain/debug/txpool", (c) => {
		const pending = getPendingTransactions(client.txPool);
		return c.json({
			pendingCount: pending.length,
			pending: pending.map((tx) => ({
				hash: txHash(tx),
				to: tx.to,
				value: tx.value.toString(),
				nonce: tx.nonce.toString(),
			})),
		});
	});

	app.get("/blockchain/debug/messages", (c) => {
		const limitParam = c.req.query("limit");
		const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
		const typeFilter = c.req.query("type");

		let messages = client.receivedMessages;
		if (typeFilter) {
			messages = messages.filter((m) => m.type === typeFilter);
		}

		// Return most recent messages
		const recent = messages.slice(-limit).reverse();

		return c.json({
			total: client.receivedMessages.length,
			showing: recent.length,
			messages: recent.map((m) => ({
				timestamp: m.timestamp,
				time: new Date(m.timestamp).toISOString(),
				type: m.type,
				from: m.from,
				data: m.data,
			})),
		});
	});

	app.get("/blockchain/debug/messages/stats", (c) => {
		const stats = new Map<string, number>();
		for (const msg of client.receivedMessages) {
			stats.set(msg.type, (stats.get(msg.type) || 0) + 1);
		}

		return c.json({
			total: client.receivedMessages.length,
			byType: Object.fromEntries(stats),
		});
	});
}

