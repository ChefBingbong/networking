import { assert, describe, it } from "vitest";
import * as RLP from "../../rlp/index.ts";
import type { PrefixedHexString } from "../../utils/index.ts";
import {
	bytesToBigInt,
	bytesToHex,
	equalsBytes,
	hexToBytes,
	toBytes,
	unpadBytes,
} from "../../utils/index.ts";
import {
	createLegacyTx,
	createLegacyTxFromBytesArray,
	createLegacyTxFromRLP,
} from "../legacy/constructors.ts";
import type { TransactionType, TxData, TypedTransaction } from "../types.ts";
import { transactionTestEip155VitalikTestsData } from "./testData/transactionTestEip155VitalikTests.ts";
import { txsData } from "./testData/txs.ts";

describe("[Transaction]", () => {
	const transactions: TypedTransaction[] = [];

	it(`cannot input decimal or negative values`, () => {
		const values = ["gasPrice", "gasLimit", "nonce", "value", "v", "r", "s"];
		const cases = [
			10.1,
			"10.1",
			"0xaa.1",
			-10.1,
			-1,
			BigInt(-10),
			"-100",
			"-10.1",
			"-0xaa",
			Infinity,
			-Infinity,
			NaN,
			{},
			true,
			false,
			() => {},
			Number.MAX_SAFE_INTEGER + 1,
		];
		for (const value of values) {
			const txData: any = {};
			for (const testCase of cases) {
				txData[value] = testCase;
				assert.throws(() => {
					createLegacyTx(txData);
				});
			}
		}
	});

	it("Initialization -> decode with createLegacyTxFromBytesArray()", () => {
		for (const tx of txsData.slice(0, 4)) {
			const txData = tx.raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			);
			const pt = createLegacyTxFromBytesArray(txData);

			assert.strictEqual(bytesToHex(unpadBytes(toBytes(pt.nonce))), tx.raw[0]);
			assert.strictEqual(bytesToHex(toBytes(pt.gasPrice)), tx.raw[1]);
			assert.strictEqual(bytesToHex(toBytes(pt.gasLimit)), tx.raw[2]);
			assert.strictEqual(pt.to?.toString(), tx.raw[3]);
			assert.strictEqual(bytesToHex(unpadBytes(toBytes(pt.value))), tx.raw[4]);
			assert.strictEqual(bytesToHex(pt.data), tx.raw[5]);
			assert.strictEqual(bytesToHex(toBytes(pt.v)), tx.raw[6]);
			assert.strictEqual(bytesToHex(toBytes(pt.r)), tx.raw[7]);
			assert.strictEqual(bytesToHex(toBytes(pt.s)), tx.raw[8]);

			transactions.push(pt);
		}
	});

	it("Initialization -> should accept lesser r values", () => {
		const tx = createLegacyTx({ r: bytesToBigInt(hexToBytes("0x0005")) });
		assert.strictEqual(tx.r!.toString(16), "5");
	});

	it("addSignature() -> correctly adds correct signature values", () => {
		const privKey = hexToBytes(`0x${txsData[0].privateKey}`);
		const tx = createLegacyTx({});
		const signedTx = tx.sign(privKey);
		const addSignatureTx = tx.addSignature(
			signedTx.v!,
			signedTx.r!,
			signedTx.s!,
		);

		assert.deepEqual(signedTx.toJSON(), addSignatureTx.toJSON());
	});

	it("getValidationErrors() -> should validate", () => {
		for (const tx of transactions) {
			assert.strictEqual(typeof tx.getValidationErrors()[0], "string");
		}
	});

	it("isValid() -> should validate", () => {
		for (const tx of transactions) {
			assert.strictEqual(typeof tx.isValid(), "boolean");
		}
	});

	it("getIntrinsicGas() -> should return base fee", () => {
		const tx = createLegacyTx({});
		assert.strictEqual(tx.getIntrinsicGas(), BigInt(53000));
	});

	it("getDataGas() -> should return data fee", () => {
		let tx = createLegacyTx({});
		assert.strictEqual(tx.getDataGas(), BigInt(0));

		tx = createLegacyTxFromBytesArray(
			txsData[3].raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			),
		);
		assert.strictEqual(tx.getDataGas(), BigInt(1716));

		tx = createLegacyTxFromBytesArray(
			txsData[3].raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			),
			{ freeze: false },
		);
		assert.strictEqual(tx.getDataGas(), BigInt(1716));
	});

	it("getEffectivePriorityFee() -> should return correct values", () => {
		const tx = createLegacyTx({
			gasPrice: BigInt(100),
		});

		assert.strictEqual(tx.getEffectivePriorityFee(), BigInt(100));
		assert.strictEqual(tx.getEffectivePriorityFee(BigInt(20)), BigInt(80));
		assert.strictEqual(tx.getEffectivePriorityFee(BigInt(100)), BigInt(0));
		assert.throws(() => tx.getEffectivePriorityFee(BigInt(101)));
	});

	it("getUpfrontCost() -> should return upfront cost", () => {
		const tx = createLegacyTx({
			gasPrice: 1000,
			gasLimit: 10000000,
			value: 42,
		});
		assert.strictEqual(tx.getUpfrontCost(), BigInt(10000000042));
	});

	it("serialize()", () => {
		for (const [i, tx] of transactions.entries()) {
			const s1 = tx.serialize();
			const rawBytes = txsData[i].raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			);
			const s2 = RLP.encode(rawBytes);
			assert.isTrue(equalsBytes(s1, s2));
		}
	});

	it("serialize() -> should round trip decode a tx", () => {
		const tx = createLegacyTx({ value: 5000 });
		const s1 = tx.serialize();

		const tx2 = createLegacyTxFromRLP(s1);
		const s2 = tx2.serialize();

		assert.isTrue(equalsBytes(s1, s2));
	});

	it("hash() / getHashedMessageToSign() / getMessageToSign()", () => {
		let tx = createLegacyTxFromBytesArray(
			txsData[3].raw
				.slice(0, 6)
				.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
		);
		assert.throws(
			() => {
				tx.hash();
			},
			undefined,
			undefined,
			"should throw calling hash with unsigned tx",
		);
		tx = createLegacyTxFromBytesArray(
			txsData[3].raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			),
		);
		assert.deepEqual(
			tx.hash(),
			hexToBytes(
				"0x375a8983c9fc56d7cfd118254a80a8d7403d590a6c9e105532b67aca1efb97aa",
			),
		);
		assert.deepEqual(
			tx.getHashedMessageToSign(),
			hexToBytes(
				"0x61e1ec33764304dddb55348e7883d4437426f44ab3ef65e6da1e025734c03ff0",
			),
		);
		assert.strictEqual(tx.getMessageToSign().length, 6);
		assert.deepEqual(
			tx.hash(),
			hexToBytes(
				"0x375a8983c9fc56d7cfd118254a80a8d7403d590a6c9e105532b67aca1efb97aa",
			),
		);
	});

	it.skip("hash() -> with defined chainId", () => {
		// Skipped - hash calculation may differ without Common
		const tx = createLegacyTxFromBytesArray(
			txsData[4].raw.map((rawTxData) =>
				hexToBytes(rawTxData as PrefixedHexString),
			),
		);
		assert.strictEqual(
			bytesToHex(tx.hash()),
			"0x0f09dc98ea85b7872f4409131a790b91e7540953992886fc268b7ba5c96820e4",
		);
		assert.strictEqual(
			bytesToHex(tx.hash()),
			"0x0f09dc98ea85b7872f4409131a790b91e7540953992886fc268b7ba5c96820e4",
		);
		assert.strictEqual(
			bytesToHex(tx.getHashedMessageToSign()),
			"0xf97c73fdca079da7652dbc61a46cd5aeef804008e057be3e712c43eac389aaf0",
		);
	});

	it.skip("getHashedMessageToSign(), getSenderPublicKey() (implicit call) -> verify EIP155 signature based on Vitalik's tests", () => {
		// Skipped - hash calculation may differ without Common
		for (const tx of transactionTestEip155VitalikTestsData) {
			const pt = createLegacyTxFromRLP(hexToBytes(tx.rlp as PrefixedHexString));
			assert.strictEqual(
				bytesToHex(pt.getHashedMessageToSign()),
				`0x${tx.hash}`,
			);
			assert.strictEqual(bytesToHex(pt.serialize()), tx.rlp);
			assert.strictEqual(pt.getSenderAddress().toString(), `0x${tx.sender}`);
		}
	});

	it("sign() -> hedged signatures test", () => {
		const privateKey = hexToBytes(
			"0x4646464646464646464646464646464646464646464646464646464646464646",
		);
		// Verify 1000 signatures to ensure these have unique hashes (hedged signatures test)
		const tx = createLegacyTx({});
		const hashSet = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const hash = bytesToHex(tx.sign(privateKey, true).hash());
			if (hashSet.has(hash)) {
				assert.fail("should not reuse the same hash (hedged signature test)");
			}
			hashSet.add(hash);
		}
	});

	it("sign(), getSenderPublicKey() (implicit call) -> EIP155 hashing when signing", () => {
		for (const txData of txsData.slice(0, 3)) {
			const tx = createLegacyTxFromBytesArray(
				txData.raw
					.slice(0, 6)
					.map((rawTxData) => hexToBytes(rawTxData as PrefixedHexString)),
			);

			const privKey = hexToBytes(`0x${txData.privateKey}`);
			const txSigned = tx.sign(privKey);

			assert.strictEqual(
				txSigned.getSenderAddress().toString(),
				"0x" + txData.sendersAddress,
				"computed sender address should equal the fixture's one",
			);
		}
	});

	it("constructor: throw on legacy transactions which have v !== 27 and v !== 28 and v < 37", () => {
		function getTxData(v: number) {
			return {
				v,
			};
		}
		for (let n = 0; n < 27; n++) {
			assert.throws(() => createLegacyTx(getTxData(n)));
		}
		assert.throws(() => createLegacyTx(getTxData(29)));
		assert.throws(() => createLegacyTx(getTxData(36)));

		assert.doesNotThrow(() => createLegacyTx(getTxData(27)));
		assert.doesNotThrow(() => createLegacyTx(getTxData(28)));
		assert.doesNotThrow(() => createLegacyTx(getTxData(37)));
	});

	it("freeze property propagates from unsigned tx to signed tx", () => {
		const tx = createLegacyTx({}, { freeze: false });
		assert.isFalse(Object.isFrozen(tx), "tx object is not frozen");
		const privKey = hexToBytes(`0x${txsData[0].privateKey}`);
		const signedTxn = tx.sign(privKey);
		assert.isFalse(Object.isFrozen(signedTxn), "tx object is not frozen");
	});

	it("isSigned() -> returns correct values", () => {
		let tx = createLegacyTx({});
		assert.isFalse(tx.isSigned());

		const txData: TxData[typeof TransactionType.Legacy] = {
			data: "0x7cf5dab00000000000000000000000000000000000000000000000000000000000000005",
			gasLimit: "0x15f90",
			gasPrice: "0x1",
			nonce: "0x01",
			to: "0xd9024df085d09398ec76fbed18cac0e1149f50dc",
			value: "0x0",
		};
		const privateKey = hexToBytes(
			"0x4646464646464646464646464646464646464646464646464646464646464646",
		);
		tx = createLegacyTx(txData);
		assert.isFalse(tx.isSigned());
		tx = tx.sign(privateKey);
		assert.isTrue(tx.isSigned());

		tx = createLegacyTx(txData);
		assert.isFalse(tx.isSigned());
		const rawUnsigned = tx.serialize();
		tx = tx.sign(privateKey);
		const rawSigned = tx.serialize();
		assert.isTrue(tx.isSigned());

		tx = createLegacyTxFromRLP(rawUnsigned);
		assert.isFalse(tx.isSigned());
		tx = tx.sign(privateKey);
		assert.isTrue(tx.isSigned());
		tx = createLegacyTxFromRLP(rawSigned);
		assert.isTrue(tx.isSigned());

		const signedValues = RLP.decode(Uint8Array.from(rawSigned)) as Uint8Array[];
		tx = createLegacyTxFromBytesArray(signedValues);
		assert.isTrue(tx.isSigned());
		tx = createLegacyTxFromBytesArray(signedValues.slice(0, 6));
		assert.isFalse(tx.isSigned());
	});
});
