// src/blockchain/client/client.ts

import { getGlobalAppInstance } from "../../http";
import { addBlockchainApiRoutes } from "../../http/blockchain-api";
import type { PeerNode } from "../../node/node";
import { blockHash, createBlock } from "../block/block";
import { createChain, getCanonicalHead } from "../blockchain/chain";
import { getChainConfig } from "../config/chain-config";
import { initializeGenesis } from "../config/genesis";
import { type EVMState, evmCall } from "../evm/evm";
import {
	createBlockchainProtocolHandler,
	handleBlockchainMessageForClient,
} from "../p2p/handler";
import { BLOCKCHAIN_PROTOCOL, type BlockchainMessage } from "../p2p/protocol";
import {
	addTransaction,
	createTxPool,
	getPendingTransactions,
} from "../p2p/tx-pool";
import { createStateManager, getAccount } from "../state/state-manager";
import type { Address, Block, ChainConfig, Transaction, Wei } from "../types";
import { mineBlock } from "./miner";

export interface BlockchainClientState {
	chain: ReturnType<typeof createChain>;
	stateManager: ReturnType<typeof createStateManager>;
	txPool: ReturnType<typeof createTxPool>;
	node: PeerNode;
	config: ChainConfig;
	syncing: boolean;
	minerAddress: Address;
	receivedMessages: Array<{
		timestamp: number;
		type: string;
		from?: string;
		data?: any;
	}>;
}

export function createBlockchainClient(
	node: PeerNode,
	configName: string,
	genesis?: any,
	minerAddress?: Address,
): BlockchainClientState {
	const config = getChainConfig(configName);
	const chain = createChain(
		createBlock(
			{
				parentHash:
					"0x0000000000000000000000000000000000000000000000000000000000000000",
				ommersHash:
					"0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
				beneficiary:
					minerAddress ?? "0x0000000000000000000000000000000000000000",
				stateRoot:
					"0x0000000000000000000000000000000000000000000000000000000000000000",
				transactionsRoot:
					"0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
				receiptsRoot:
					"0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
				logsBloom: new Uint8Array(256).fill(0),
				difficulty: BigInt(config.genesis.difficulty),
				number: 0n,
				gasLimit: BigInt(config.genesis.gasLimit),
				gasUsed: 0n,
				timestamp: BigInt(config.genesis.timestamp),
				extraData: new Uint8Array(0),
				mixHash:
					"0x0000000000000000000000000000000000000000000000000000000000000000",
				nonce: 0n,
			},
			[],
		),
		config,
	);

	const stateManager = createStateManager();
	const genesisConfig = genesis ?? config.genesis;
	initializeGenesis(chain, genesisConfig, stateManager);

	const client: BlockchainClientState = {
		chain,
		stateManager,
		txPool: createTxPool(),
		node,
		config,
		syncing: false,
		minerAddress: minerAddress ?? "0x0000000000000000000000000000000000000000",
		receivedMessages: [],
	};

	return client;
}

export async function clientStart(
	client: BlockchainClientState,
): Promise<void> {
	// Register blockchain protocol handler
	const handler = createBlockchainProtocolHandler(client);
	client.node.handleProtocol(BLOCKCHAIN_PROTOCOL, handler);
	client.syncing = true;

	// Store blockchain client on node for API access
	(client.node as any).blockchainClient = client;

	// Add blockchain routes to existing API if it exists
	const app = getGlobalAppInstance?.();
	if (app) {
		addBlockchainApiRoutes(app, client);
	}

	// Start sync process - connect to peers and sync blocks
	startSyncLoop(client);
}

function startSyncLoop(client: BlockchainClientState): void {
	// Periodically sync with peers
	setInterval(async () => {
		if (!client.syncing) return;

		const peers = Array.from(client.node.connections.keys());
		if (peers.length === 0) return;

		// Try to sync with a random peer
		const peerAddr = peers[Math.floor(Math.random() * peers.length)];
		if (!peerAddr) return;

		try {
			await syncWithPeer(client, peerAddr);
		} catch (err) {
			// Ignore sync errors
		}
	}, 5000); // Sync every 5 seconds
}

async function syncWithPeer(
	client: BlockchainClientState,
	peerAddr: string,
): Promise<void> {
	const conn = client.node.connections.get(peerAddr);
	if (!conn) return;

	try {
		const stream = await client.node.protocolManager.initOutgoing(
			conn,
			BLOCKCHAIN_PROTOCOL,
		);

		// Send status
		const head = getCanonicalHead(client.chain);
		if (head) {
			const statusMsg = {
				type: "Status",
				chainId: client.config.chainId,
				headHash: blockHash(head),
				headNumber: head.header.number,
			};
			stream.send(Buffer.from(JSON.stringify(statusMsg), "utf-8"));
		}

		// Listen for responses
		stream.addEventListener("message", async (evt: { data: any }) => {
			try {
				const msg = JSON.parse(
					Buffer.from(evt.data).toString("utf-8"),
				) as BlockchainMessage;
				await handleBlockchainMessageForClient(client, msg);
			} catch (err) {
				// Ignore errors
			}
		});

		// Close stream after a timeout
		setTimeout(() => {
			try {
				stream.close();
			} catch {}
		}, 10000);
	} catch (err) {
		// Ignore connection errors
	}
}

export function clientStop(client: BlockchainClientState): void {
	client.syncing = false;
}

export function clientMineBlock(
	client: BlockchainClientState,
	txs?: Transaction[],
): Block | null {
	const transactions = txs ?? getPendingTransactions(client.txPool);
	console.log(transactions, "transactions");
	return mineBlock(client, transactions);
}

export function clientSendTransaction(
	client: BlockchainClientState,
	tx: Transaction,
): boolean {
	return addTransaction(client.txPool, tx, client.stateManager);
}

export function clientGetBalance(
	client: BlockchainClientState,
	address: Address,
): Wei {
	const account = getAccount(client.stateManager, address);
	return account.balance;
}

export function clientGetAccount(
	client: BlockchainClientState,
	address: Address,
) {
	return getAccount(client.stateManager, address);
}

export function clientCall(
	client: BlockchainClientState,
	to: Address,
	data: Uint8Array,
	from?: Address,
	value?: Wei,
): Uint8Array {
	const head = client.chain.blocks.get(client.chain.canonicalHead);
	if (!head) {
		throw new Error("No head block");
	}

	const evmState: EVMState = {
		stateManager: client.stateManager,
		block: head,
		tx: {
			type: "legacy",
			nonce: 0n,
			gasPrice: 0n,
			gasLimit: 1000000n,
			to,
			value: value ?? 0n,
			data,
			v: 0n,
			r: 0n,
			s: 0n,
		},
		gasUsed: 0n,
		logs: [],
		returnData: new Uint8Array(0),
	};

	const result = evmCall(
		evmState,
		to,
		value ?? 0n,
		data,
		1000000n,
		from ?? "0x0000000000000000000000000000000000000000",
	);

	return result.returnData;
}

export function clientEstimateGas(
	client: BlockchainClientState,
	tx: Transaction,
): bigint {
	// Simplified - would actually run transaction with gas metering
	return tx.gasLimit;
}
