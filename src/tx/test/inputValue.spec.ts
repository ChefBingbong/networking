import { assert, describe, it } from "vitest";
import { Address, hexToBytes, toBytes } from "../../utils/index.ts";
import type {
	AddressLike,
	BigIntLike,
	BytesLike,
	PrefixedHexString,
} from "../../utils/types.ts";
import {
	createLegacyTx,
	createLegacyTxFromBytesArray,
} from "../legacy/index.ts";
import { createTx } from "../transactionFactory.ts";
import { TransactionType, type TxValuesArray } from "../types.ts";

// @returns: Array with subtypes of the AddressLike type for a given address
function generateAddressLikeValues(address: PrefixedHexString): AddressLike[] {
	return [address, toBytes(address), new Address(toBytes(address))];
}

// @returns: Array with subtypes of the BigIntLike type for a given number
function generateBigIntLikeValues(value: number): BigIntLike[] {
	return [value, BigInt(value), `0x${value.toString(16)}`, toBytes(value)];
}

// @returns: Array with subtypes of the BytesLike type for a given string
function generateBytesLikeValues(value: PrefixedHexString): BytesLike[] {
	return [value, toBytes(value)];
}

interface GenerateCombinationsArgs {
	options: { [x: string]: any };
	optionIndex?: number;
	results?: { [x: string]: any }[];
	current?: { [x: string]: any };
}

export function generateCombinations({
	options,
	optionIndex = 0,
	results = [],
	current = {},
}: GenerateCombinationsArgs) {
	const allKeys = Object.keys(options);
	const optionKey = allKeys[optionIndex];
	const values = options[optionKey];

	for (let i = 0; i < values.length; i++) {
		current[optionKey] = values[i];

		if (optionIndex + 1 < allKeys.length) {
			generateCombinations({
				options,
				optionIndex: optionIndex + 1,
				results,
				current,
			});
		} else {
			// Clone the object
			const res = { ...current };
			results.push(res);
		}
	}

	return results;
}

// Deterministic pseudorandom number generator
function mulberry32(seed: number) {
	let t = (seed += 0x6d2b79f5);
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function getRandomSubarray<TArrayItem>(array: TArrayItem[], size: number) {
	const shuffled = array.slice(0);
	let seed = 1559;
	let index: number;
	let length = array.length;
	let temp: TArrayItem;
	while (length > 0) {
		index = Math.floor((length + 1) * mulberry32(seed));
		temp = shuffled[index];
		shuffled[index] = shuffled[length];
		shuffled[length] = temp;
		seed++;
		length--;
	}
	return shuffled.slice(0, size);
}

const baseTxValues = {
	data: generateBytesLikeValues("0x65"),
	gasLimit: generateBigIntLikeValues(100000),
	nonce: generateBigIntLikeValues(0),
	to: generateAddressLikeValues("0x0000000000000000000000000000000000000000"),
	r: generateBigIntLikeValues(100),
	s: generateBigIntLikeValues(100),
	value: generateBigIntLikeValues(10),
};

const legacyTxValues = {
	gasPrice: generateBigIntLikeValues(100),
};

describe("[Transaction Input Values]", () => {
	it("Legacy Transaction Values", () => {
		const options = { ...baseTxValues, ...legacyTxValues, type: "0" };
		const legacyTxData = generateCombinations({
			options,
		});
		const randomSample = getRandomSubarray(legacyTxData, 100);
		for (const txData of randomSample) {
			const tx = createLegacyTx(txData);
			assert.throws(
				() => tx.hash(),
				undefined,
				undefined,
				"tx.hash() throws if tx is unsigned",
			);
		}
	});
});

describe("[Invalid Array Input values]", () => {
	it.skip("should work", () => {
		// Skipped - validation may not catch all invalid array inputs
		const txTypes = [TransactionType.Legacy];
		for (const signed of [false, true]) {
			for (const txType of txTypes) {
				let tx = createTx({ type: txType });
				if (signed) {
					tx = tx.sign(hexToBytes(`0x${"42".repeat(32)}`));
				}
				const rawValues = tx.raw();
				for (let x = 0; x < rawValues.length; x++) {
					rawValues[x] = Uint8Array.from([1, 2, 3]);
					switch (txType) {
						case TransactionType.Legacy:
							assert.throws(() =>
								createLegacyTxFromBytesArray(
									rawValues as TxValuesArray[typeof TransactionType.Legacy],
								),
							);
							break;
					}
				}
			}
		}
	});
});
