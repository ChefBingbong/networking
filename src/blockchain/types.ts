// src/blockchain/types.ts

/**
 * Core blockchain primitive types
 */

// Address: 20-byte Ethereum address (hex string with 0x prefix)
export type Address = string;

// Hash: 32-byte hash (hex string with 0x prefix)
export type Hash = string;

// Block number (unsigned integer)
export type BlockNumber = bigint;

// Gas amount (unsigned integer)
export type Gas = bigint;

// Wei: smallest unit of Ether (unsigned integer)
export type Wei = bigint;

// Nonce: transaction or account nonce (unsigned integer)
export type Nonce = bigint;

/**
 * Block types
 */

export interface BlockHeader {
	parentHash: Hash;
	ommersHash: Hash;
	beneficiary: Address;
	stateRoot: Hash;
	transactionsRoot: Hash;
	receiptsRoot: Hash;
	logsBloom: Uint8Array; // 256 bytes
	difficulty: bigint;
	number: bigint;
	gasLimit: bigint;
	gasUsed: bigint;
	timestamp: bigint;
	extraData: Uint8Array;
	mixHash: Hash;
	nonce: bigint;
}

export interface BlockBody {
	transactions: Transaction[];
	ommers?: BlockHeader[]; // Optional for now (Ethereum 2.0 removed ommers)
}

export interface Block {
	header: BlockHeader;
	transactions: Transaction[];
	ommers?: BlockHeader[];
}

/**
 * Transaction types
 */

export type TransactionType = "legacy" | "eip1559" | "eip2930" | "eip155";

export interface LegacyTransaction {
	type: "legacy";
	nonce: bigint;
	gasPrice: bigint;
	gasLimit: bigint;
	to?: Address;
	value: bigint;
	data: Uint8Array;
	v: bigint;
	r: bigint;
	s: bigint;
	chainId?: bigint;
}

export interface EIP1559Transaction {
	type: "eip1559";
	nonce: bigint;
	maxFeePerGas: bigint;
	maxPriorityFeePerGas: bigint;
	gasLimit: bigint;
	to?: Address;
	value: bigint;
	data: Uint8Array;
	v: bigint;
	r: bigint;
	s: bigint;
	chainId: bigint;
}

export type Transaction = LegacyTransaction | EIP1559Transaction;

export interface TransactionReceipt {
	status: 0 | 1; // 0 = failed, 1 = success
	cumulativeGasUsed: bigint;
	logsBloom: Uint8Array; // 256 bytes
	logs: Log[];
	transactionHash: Hash;
	transactionIndex: number;
	blockHash: Hash;
	blockNumber: bigint;
	from: Address;
	to?: Address;
	contractAddress?: Address;
	gasUsed: bigint;
}

export interface Log {
	address: Address;
	topics: Hash[];
	data: Uint8Array;
}

/**
 * State types
 */

export interface AccountState {
	nonce: bigint;
	balance: bigint;
	storageRoot: Hash;
	codeHash: Hash;
}

export type StorageSlot = Hash; // Storage key/value are both 32-byte hashes

export interface WorldState {
	accounts: Map<Address, AccountState>;
	storage: Map<Address, Map<Hash, Hash>>;
	code: Map<Address, Uint8Array>;
}

/**
 * Chain configuration types
 */

export interface Hardfork {
	name: string;
	block: bigint;
	eips: number[];
}

export interface GenesisConfig {
	timestamp: string;
	gasLimit: string;
	difficulty: string;
	extraData: string;
	alloc: Record<
		Address,
		{
			balance: string;
			code?: string;
			storage?: Record<string, string>;
		}
	>;
}

export interface ChainConfig {
	chainId: bigint;
	name: string;
	hardforks: Hardfork[];
	genesis: GenesisConfig;
	clique?: {
		epoch: number; // Number of blocks between epoch transitions
		period: number; // Minimum time between blocks (seconds)
	};
}

/**
 * Utility types
 */

export interface StateSnapshot {
	accounts: Map<Address, AccountState>;
	storage: Map<Address, Map<Hash, Hash>>;
	code: Map<Address, Uint8Array>;
}

