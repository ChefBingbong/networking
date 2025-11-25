import { assert, describe, it } from "vitest";
import { hexToBytes } from "../../utils/index.ts";
import { createLegacyTx } from "../legacy/constructors.ts";
import { LegacyTx } from "../legacy/tx.ts";
import {
	createTx,
	createTxFromBlockBodyData,
	createTxFromRLP,
} from "../transactionFactory.ts";
import { TransactionType } from "../types.ts";

const pKey = hexToBytes(
	"0x4646464646464646464646464646464646464646464646464646464646464646",
);

const unsignedLegacyTx = createLegacyTx({});
const signedLegacyTx = unsignedLegacyTx.sign(pKey);

const txTypes = [
	{
		class: LegacyTx,
		name: "LegacyTx",
		unsigned: unsignedLegacyTx,
		signed: signedLegacyTx,
		eip2718: false,
		type: TransactionType.Legacy,
	},
];

describe("[TransactionFactory]: Basic functions", () => {
	it("fromSerializedData() -> success cases", () => {
		for (const txType of txTypes) {
			const serialized = txType.unsigned.serialize();
			const factoryTx = createTxFromRLP(serialized);
			assert.strictEqual(
				factoryTx.constructor.name,
				txType.class.name,
				`should return the right type (${txType.name})`,
			);
		}
	});

	it("fromBlockBodyData() -> success cases", () => {
		for (const txType of txTypes) {
			let rawTx: Uint8Array | Uint8Array[];
			if (txType.eip2718) {
				rawTx = txType.signed.serialize();
			} else {
				rawTx = txType.signed.raw() as Uint8Array[];
			}
			const tx = createTxFromBlockBodyData(rawTx);
			assert.strictEqual(
				tx.constructor.name,
				txType.name,
				`should return the right type (${txType.name})`,
			);
			if (txType.eip2718) {
				assert.deepEqual(
					tx.serialize(),
					rawTx,
					`round-trip serialization should match (${txType.name})`,
				);
			} else {
				assert.deepEqual(
					tx.raw(),
					rawTx as Uint8Array[],
					`round-trip raw() creation should match (${txType.name})`,
				);
			}
		}
	});

	it("fromTxData() -> success cases", () => {
		for (const txType of txTypes) {
			const tx = createTx({ type: txType.type });
			assert.strictEqual(
				tx.constructor.name,
				txType.class.name,
				`should return the right type (${txType.name})`,
			);
			if (!txType.eip2718) {
				const tx = createTx({});
				assert.strictEqual(
					tx.constructor.name,
					txType.class.name,
					`should return the right type (${txType.name})`,
				);
			}
		}
	});

	it("fromTxData() -> error cases", () => {
		assert.throws(() => {
			createTx({ type: 999 } as any);
		});

		assert.throws(() => {
			createTx({ value: BigInt("-100") } as any);
		});
	});
});
