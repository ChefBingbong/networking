// src/blockchain/client/client.ts

import { getGlobalAppInstance } from "../../http";
import { addBlockchainApiRoutes } from "../../http/blockchain-api";
import type { PeerNode } from "../../node/node";
import { blockHash, createBlock } from "../block/block";
import { createHeader } from "../block/header";
import { createChain, getCanonicalHead } from "../blockchain/chain";
import { getChainConfig } from "../config/chain-config";
import { initializeGenesis } from "../config/genesis";
import {
	type CliqueConsensusState,
	cliqueGenesisInit,
	createCliqueConsensus,
	setupCliqueConsensus,
} from "../consensus/clique";
import { signCliqueHeader } from "../consensus/clique/utils";
import { createDatabase } from "../db/database";
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
import type {
	Address,
	Block,
	ChainConfig,
	GenesisConfig,
	Transaction,
	Wei,
} from "../types";
import { hexToBytes } from "../utils";
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
		data?: BlockchainMessage;
	}>;
	clique?: CliqueConsensusState;
	db?: ReturnType<typeof createDatabase>;
}

export function createBlockchainClient(
	node: PeerNode,
	configName: string,
	genesis?: GenesisConfig,
	minerAddress?: Address,
	dbPath?: string,
	minerPrivateKey?: Uint8Array,
	signerAddresses?: Address[], // For Clique: list of all signer addresses
): BlockchainClientState {
	const config = getChainConfig(configName);

	// Handle Clique genesis extraData setup if Clique is enabled
	let finalGenesisConfig: GenesisConfig = genesis ?? config.genesis;
	if (
		config.clique &&
		signerAddresses &&
		signerAddresses.length > 0 &&
		minerPrivateKey
	) {
		// Create genesis extraData with signers (for epoch transition)
		// Format: [vanity (32 bytes)][signers (20 bytes each)][signature (65 bytes)]
		const vanity = new Uint8Array(32).fill(0);
		const signersData = new Uint8Array(signerAddresses.length * 20);
		for (let i = 0; i < signerAddresses.length; i++) {
			const signerBytes = Uint8Array.from(
				Buffer.from(signerAddresses[i]!.slice(2), "hex"),
			);
			signersData.set(signerBytes, i * 20);
		}

		// Create extraData with vanity + signers (without signature)
		const extraDataWithoutSig = new Uint8Array(32 + signersData.length);
		extraDataWithoutSig.set(vanity, 0);
		extraDataWithoutSig.set(signersData, 32);

		// Create a temporary header for signing
		const tempHeader = createHeader({
			number: 0n,
			gasLimit: BigInt(finalGenesisConfig.gasLimit),
			difficulty: BigInt(finalGenesisConfig.difficulty),
			timestamp: BigInt(finalGenesisConfig.timestamp),
			extraData: extraDataWithoutSig,
		});

		// Sign the header with first signer's private key
		const signedHeader = signCliqueHeader(tempHeader, minerPrivateKey);

		// Update genesis config with signed extraData
		finalGenesisConfig = {
			...finalGenesisConfig,
			extraData: `0x${Buffer.from(signedHeader.extraData).toString("hex")}`,
		};
	}

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
				difficulty: BigInt(finalGenesisConfig.difficulty),
				number: 0n,
				gasLimit: BigInt(finalGenesisConfig.gasLimit),
				gasUsed: 0n,
				timestamp: BigInt(finalGenesisConfig.timestamp),
				extraData: hexToBytes(finalGenesisConfig.extraData),
				mixHash:
					"0x0000000000000000000000000000000000000000000000000000000000000000",
				nonce: 0n,
			},
			[],
		),
		config,
	);

	const stateManager = createStateManager();
	initializeGenesis(chain, finalGenesisConfig, stateManager);

	// Initialize database and Clique if config has Clique enabled
	let db: ReturnType<typeof createDatabase> | undefined;
	let clique: CliqueConsensusState | undefined;

	if (config.clique) {
		// Use provided dbPath or generate a default one
		const finalDbPath = dbPath ?? `./clique/clique-db-default`;
		db = createDatabase(finalDbPath);
		clique = createCliqueConsensus(db, {
			epoch: config.clique.epoch,
			period: config.clique.period,
		});
	}

	const client: BlockchainClientState = {
		chain,
		stateManager,
		txPool: createTxPool(),
		node,
		config,
		syncing: false,
		minerAddress: minerAddress ?? "0x0000000000000000000000000000000000000000",
		receivedMessages: [],
		clique,
		db,
	};

	// Store miner private key for Clique signing if provided
	if (minerPrivateKey && config.clique) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(client as any).minerPrivateKey = minerPrivateKey;
	}

	return client;
}

export async function clientStart(
	client: BlockchainClientState,
): Promise<void> {
	// Initialize Clique consensus if configured
	if (client.clique && client.db) {
		await setupCliqueConsensus(client.clique);
		const genesisBlock = client.chain.genesis;
		await cliqueGenesisInit(client.clique, genesisBlock);
	}

	// Register blockchain protocol handler
	const handler = createBlockchainProtocolHandler(client);
	client.node.handleProtocol(BLOCKCHAIN_PROTOCOL, handler);
	client.syncing = true;

	// Store blockchain client on node for API access
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
	// Periodically discover and connect to peers via Kademlia
	setInterval(async () => {
		if (!client.syncing) return;

		// Use Kademlia to discover new peers
		try {
			const target = client.node.kad.randomNodeId();
			const discoveredPeers = await client.node.kad.nodeLookup(target);

			// Connect to discovered peers
			for (const contact of discoveredPeers) {
				try {
					await client.node.dial(contact.addr);
				} catch {
					// Ignore connection errors
				}
			}
		} catch {
			// Ignore discovery errors
		}
	}, 10000); // Discover peers every 10 seconds

	// Periodically sync blockchain state with connected peers
	setInterval(async () => {
		if (!client.syncing) return;

		const peers = Array.from(client.node.connections.keys());
		if (peers.length === 0) return;

		// Try to sync with a random peer
		const peerAddr = peers[Math.floor(Math.random() * peers.length)];
		if (!peerAddr) return;

		try {
			await syncWithPeer(client, peerAddr);
		} catch {
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
		stream.addEventListener("message", async (evt: { data: Uint8Array }) => {
			try {
				const msg = JSON.parse(
					Buffer.from(evt.data).toString("utf-8"),
				) as BlockchainMessage;
				await handleBlockchainMessageForClient(client, msg, peerAddr);
			} catch {
				// Ignore errors
			}
		});

		// Close stream after a timeout
		setTimeout(() => {
			try {
				stream.close();
			} catch {
				// Ignore close errors
			}
		}, 10000);
	} catch {
		// Ignore connection errors
	}
}

export function clientStop(client: BlockchainClientState): void {
	client.syncing = false;
}

export async function clientMineBlock(
	client: BlockchainClientState,
	txs?: Transaction[],
): Promise<Block | null> {
	const transactions = txs ?? getPendingTransactions(client.txPool);
	console.log(transactions, "transactions");
	return await mineBlock(client, transactions);
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
	_client: BlockchainClientState,
	tx: Transaction,
): bigint {
	// Simplified - would actually run transaction with gas metering
	return tx.gasLimit;
}
