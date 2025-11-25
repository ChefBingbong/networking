import type {
	Address,
	AddressLike,
	BigIntLike,
	BytesLike,
	EOACode7702AuthorizationList,
	PrefixedHexString,
} from "../utils/index.ts";
import { bytesToBigInt, toBytes } from "../utils/index.ts";
import type { LegacyTx } from "./legacy/tx.ts";

export interface TxOptions {
	common?: any;
	params?: any;
	freeze?: boolean;
	allowUnlimitedInitCodeSize?: boolean;
}

export function isAccessListBytes(
	input: AccessListBytes | AccessList,
): input is AccessListBytes {
	if (input.length === 0) {
		return true;
	}
	const firstItem = input[0];
	if (Array.isArray(firstItem)) {
		return true;
	}
	return false;
}

export function isAccessList(
	input: AccessListBytes | AccessList,
): input is AccessList {
	return !isAccessListBytes(input); // This is exactly the same method, except the output is negated.
}

export interface TransactionCache {
	hash?: Uint8Array;
	dataFee?: {
		value: bigint;
		hardfork: string;
	};
	senderPubKey?: Uint8Array;
}

export type TransactionType =
	(typeof TransactionType)[keyof typeof TransactionType];

export const TransactionType = {
	Legacy: 0,
} as const;

export interface Transaction {
	[TransactionType.Legacy]: LegacyTx;
}

export type TypedTransaction = Transaction[TransactionType];

export function isLegacyTx(tx: TypedTransaction): tx is LegacyTx {
	return tx.type === TransactionType.Legacy;
}

export interface TransactionInterface<
	T extends TransactionType = TransactionType,
> {
	readonly common: any;
	readonly nonce: bigint;
	readonly gasLimit: bigint;
	readonly to?: Address;
	readonly value: bigint;
	readonly data: Uint8Array;
	readonly v?: bigint;
	readonly r?: bigint;
	readonly s?: bigint;
	readonly cache: TransactionCache;
	type: TransactionType;
	txOptions: TxOptions;
	getIntrinsicGas(): bigint;
	getDataGas(): bigint;
	getUpfrontCost(): bigint;
	toCreationAddress(): boolean;
	raw(): TxValuesArray[T];
	serialize(): Uint8Array;
	getMessageToSign(): Uint8Array | Uint8Array[];
	getHashedMessageToSign(): Uint8Array;
	hash(): Uint8Array;
	getMessageToVerifySignature(): Uint8Array;
	getValidationErrors(): string[];
	isSigned(): boolean;
	isValid(): boolean;
	verifySignature(): boolean;
	getSenderAddress(): Address;
	getSenderPublicKey(): Uint8Array;
	sign(
		privateKey: Uint8Array,
		extraEntropy?: Uint8Array | boolean,
	): Transaction[T];
	toJSON(): JSONTx;
	errorStr(): string;

	addSignature(
		v: bigint,
		r: Uint8Array | bigint,
		s: Uint8Array | bigint,
		convertV?: boolean,
	): Transaction[T];
}

export interface LegacyTxInterface<T extends TransactionType = TransactionType>
	extends TransactionInterface<T> {}

export interface TxData {
	[TransactionType.Legacy]: LegacyTxData;
}

export type TypedTxData = TxData[TransactionType];

export function isLegacyTxData(txData: TypedTxData): txData is LegacyTxData {
	const txType = Number(bytesToBigInt(toBytes(txData.type)));
	return txType === TransactionType.Legacy;
}

export type LegacyTxData = {
	nonce?: BigIntLike;
	gasPrice?: BigIntLike | null;
	gasLimit?: BigIntLike;
	to?: AddressLike | "";

	value?: BigIntLike;
	data?: BytesLike | "";
	v?: BigIntLike;

	r?: BigIntLike;

	s?: BigIntLike;
	type?: BigIntLike;
};

export interface TxValuesArray {
	[TransactionType.Legacy]: LegacyTxValuesArray;
}

type LegacyTxValuesArray = Uint8Array[];

type JSONAccessListItem = { address: string; storageKeys: string[] };

export interface JSONTx {
	nonce?: PrefixedHexString;
	gasPrice?: PrefixedHexString;
	gasLimit?: PrefixedHexString;
	to?: PrefixedHexString;
	data?: PrefixedHexString;
	v?: PrefixedHexString;
	r?: PrefixedHexString;
	s?: PrefixedHexString;
	value?: PrefixedHexString;
	chainId?: PrefixedHexString;
	accessList?: JSONAccessListItem[]; // TODO should this not be AccessList?
	authorizationList?: EOACode7702AuthorizationList;
	type?: PrefixedHexString;
	maxPriorityFeePerGas?: PrefixedHexString;
	maxFeePerGas?: PrefixedHexString;
	maxFeePerBlobGas?: PrefixedHexString;
	blobVersionedHashes?: PrefixedHexString[];
	yParity?: PrefixedHexString;
}

export type JSONBlobTxNetworkWrapper = JSONTx & {
	networkWrapperVersion: PrefixedHexString;
	blobs: PrefixedHexString[];
	kzgCommitments: PrefixedHexString[];
	kzgProofs: PrefixedHexString[];
};

export interface JSONRPCTx {
	blockHash: string | null; // DATA, 32 Bytes - hash of the block where this transaction was in. null when it's pending.
	blockNumber: string | null; // QUANTITY - block number where this transaction was in. null when it's pending.
	from: string; // DATA, 20 Bytes - address of the sender.
	gas: string; // QUANTITY - gas provided by the sender.
	gasPrice: string; // QUANTITY - gas price provided by the sender in wei. If EIP-1559 tx, defaults to maxFeePerGas.
	maxFeePerGas?: string; // QUANTITY - max total fee per gas provided by the sender in wei.
	maxPriorityFeePerGas?: string; // QUANTITY - max priority fee per gas provided by the sender in wei.
	type: string; // QUANTITY - EIP-2718 Typed Transaction type
	accessList?: JSONTx["accessList"]; // EIP-2930 access list
	chainId?: string; // Chain ID that this transaction is valid on.
	hash: string; // DATA, 32 Bytes - hash of the transaction.
	input: string; // DATA - the data send along with the transaction.
	nonce: string; // QUANTITY - the number of transactions made by the sender prior to this one.
	to: string | null; /// DATA, 20 Bytes - address of the receiver. null when it's a contract creation transaction.
	transactionIndex: string | null; // QUANTITY - integer of the transactions index position in the block. null when it's pending.
	value: string; // QUANTITY - value transferred in Wei.
	v: string; // QUANTITY - ECDSA recovery id
	r: string; // DATA, 32 Bytes - ECDSA signature r
	s: string; // DATA, 32 Bytes - ECDSA signature s
	maxFeePerBlobGas?: string; // QUANTITY - max data fee for blob transactions
	blobVersionedHashes?: string[]; // DATA - array of 32 byte versioned hashes for blob transactions
	yParity?: string; // DATA - parity of the y-coordinate of the public key
}

export type AccessListItem = {
	address: PrefixedHexString;
	storageKeys: PrefixedHexString[];
};

export type AccessListBytesItem = [Uint8Array, Uint8Array[]];
export type AccessListBytes = AccessListBytesItem[];
export type AccessList = AccessListItem[];
