// src/blockchain/config/genesis.ts
import type { Block, ChainState, GenesisConfig, Address, Hash } from "../types";
import { createHeader } from "../block/header";
import { createBlock, blockHash } from "../block/block";
import type { StateManagerState } from "../state/state-manager";
import { hexToBytes } from "../utils";
import { keccak256Hash, hashToHex } from "../utils";
import { putAccountCode, putAccount } from "../state/state-manager";
import { createAccount } from "../state/account";
import { calculateStateRoot } from "../state/state-manager";

export function parseGenesis(genesisJson: GenesisConfig): GenesisConfig {
	// Validate and return genesis config
	return genesisJson;
}

export function initializeGenesis(
	chain: ChainState,
	genesis: GenesisConfig,
	stateManager: StateManagerState,
): void {
	// Initialize accounts from genesis alloc
	for (const [address, accountData] of Object.entries(genesis.alloc)) {
		const account = {
			nonce: 0n,
			balance: BigInt(accountData.balance),
			storageRoot:
				"0x0000000000000000000000000000000000000000000000000000000000000000",
			codeHash:
				"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
		};

		if (accountData.code) {
			const code = hexToBytes(accountData.code);
			putAccountCode(stateManager, address as Address, code);
		}

		if (accountData.storage) {
			const storage = stateManager.storage.get(address as Address) ?? new Map();
			for (const [key, value] of Object.entries(accountData.storage)) {
				storage.set(key as Hash, value as Hash);
			}
			stateManager.storage.set(address as Address, storage);
		}

		putAccount(stateManager, address as Address, account);
	}

	// Create genesis block
	const genesisHeader = createHeader({
		number: 0n,
		gasLimit: BigInt(genesis.gasLimit),
		difficulty: BigInt(genesis.difficulty),
		timestamp: BigInt(genesis.timestamp),
		extraData: hexToBytes(genesis.extraData),
		stateRoot: calculateStateRoot(stateManager),
	});

	const genesisBlock = createBlock(genesisHeader, []);

	// Update chain genesis
	chain.genesis = genesisBlock;
	chain.canonicalHead = blockHash(genesisBlock);
	// Add genesis block to chain
	chain.blocks.set(blockHash(genesisBlock), genesisBlock);
	chain.headers.set(blockHash(genesisBlock), genesisHeader);
	chain.blockByNumber.set(0n, blockHash(genesisBlock));
}

