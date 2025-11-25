import { bytesToBigInt, toBytes } from "../utils/index.ts";
import {
	createLegacyTx,
	createLegacyTxFromBytesArray,
	createLegacyTxFromRLP,
} from "./legacy/constructors.ts";
import type { Transaction, TxData, TxOptions, TypedTxData } from "./types.ts";
import { TransactionType } from "./types.ts";
import { normalizeTxParams } from "./util.ts";

export function createTx<T extends TransactionType>(
	txData: TypedTxData,
	txOptions: TxOptions = {},
): Transaction[T] {
	// Validate type if provided
	if ((txData as any).type !== undefined) {
		const type = Number(bytesToBigInt(toBytes((txData as any).type)));
		if (type !== TransactionType.Legacy) {
			throw new Error(`Unsupported transaction type: ${type}`);
		}
	}
	return createLegacyTx(txData, txOptions) as Transaction[T];
}

export function createTxFromRLP<T extends TransactionType>(
	data: Uint8Array,
	txOptions: TxOptions = {},
): Transaction[T] {
	return createLegacyTxFromRLP(data, txOptions) as Transaction[T];
}

export function createTxFromBlockBodyData(
	data: Uint8Array | Uint8Array[],
	txOptions: TxOptions = {},
) {
	if (data instanceof Uint8Array) {
		return createTxFromRLP(data, txOptions);
	} else if (Array.isArray(data)) {
		return createLegacyTxFromBytesArray(data, txOptions);
	} else {
		throw new Error("Cannot decode transaction: unknown type input");
	}
}

export async function createTxFromRPC<T extends TransactionType>(
	txData: TxData[T],
	txOptions: TxOptions = {},
): Promise<Transaction[T]> {
	return createTx(normalizeTxParams(txData), txOptions);
}
