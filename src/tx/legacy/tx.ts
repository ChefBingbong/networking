import { keccak256 } from "ethereum-cryptography/keccak.js";
import type { Common } from "../../chain-config/common.ts";
import * as RLP from "../../rlp/index.ts";
import type { Address } from "../../utils/index.ts";
import {
	BIGINT_2,
	bigIntToHex,
	bigIntToUnpaddedBytes,
	bytesToBigInt,
	MAX_INTEGER,
	toBytes,
} from "../../utils/index.ts";
import { paramsTx } from "../index.ts";
import type {
	TxData as AllTypesTxData,
	TxValuesArray as AllTypesTxValuesArray,
	JSONTx,
	TransactionCache,
	TransactionInterface,
	TxOptions,
} from "../types.ts";
import { TransactionType } from "../types.ts";
import { getBaseJSON, sharedConstructor, valueOverflowCheck } from "../util.ts";
import { createLegacyTx } from "./constructors.ts";
import * as Legacy from "./utils.ts";

export type TxData = AllTypesTxData[typeof TransactionType.Legacy];
export type TxValuesArray =
	AllTypesTxValuesArray[typeof TransactionType.Legacy];

function meetsEIP155(_v: bigint, chainId: bigint) {
	const v = Number(_v);
	const chainIdDoubled = Number(chainId) * 2;
	return v === chainIdDoubled + 35 || v === chainIdDoubled + 36;
}

/**
 * Validates tx's `v` value and extracts the chain id
 */
function validateVAndExtractChainID(
	common: Common,
	_v?: bigint,
): bigint | undefined {
	let chainIdBigInt: bigint | undefined;
	const v = _v !== undefined ? Number(_v) : undefined;
	// Check for valid v values in the scope of a signed legacy tx
	if (v !== undefined) {
		// v is 1. not matching the EIP-155 chainId included case and...
		// v is 2. not matching the classic v=27 or v=28 case
		if (v < 37 && v !== 27 && v !== 28) {
			throw new Error(
				`Legacy txs need either v = 27/28 or v >= 37 (EIP-155 replay protection), got v = ${v}`,
			);
		}
	}

	// No unsigned tx and EIP-155 activated and chain ID included
	if (
		v !== undefined &&
		v !== 0 &&
		common.gteHardfork("spuriousDragon") &&
		v !== 27 &&
		v !== 28
	) {
		if (!meetsEIP155(BigInt(v), common.chainId())) {
			throw new Error(
				`Incompatible EIP155-based V ${v} and chain id ${common.chainId()}. See the Common parameter of the Transaction constructor to set the chain id.`,
			);
		}
		// Derive the original chain ID
		let numSub: number;
		if ((v - 35) % 2 === 0) {
			numSub = 35;
		} else {
			numSub = 36;
		}
		// Use derived chain ID to create a proper Common
		chainIdBigInt = BigInt(v - numSub) / BIGINT_2;
	}
	return chainIdBigInt;
}

/**
 * An Ethereum non-typed (legacy) transaction
 */
export class LegacyTx
	implements TransactionInterface<typeof TransactionType.Legacy>
{
	/* Tx public data fields */
	public type = TransactionType.Legacy; // Legacy tx type

	// Tx data part (part of the RLP)
	public readonly gasPrice: bigint;
	public readonly nonce!: bigint;
	public readonly gasLimit!: bigint;
	public readonly value!: bigint;
	public readonly data!: Uint8Array;
	public readonly to?: Address;

	// Props only for signed txs
	public readonly v?: bigint;
	public readonly r?: bigint;
	public readonly s?: bigint;

	// End of Tx data part

	/* Other handy tx props */
	public readonly common!: Common;
	private keccakFunction: (msg: Uint8Array) => Uint8Array;

	readonly txOptions!: TxOptions;

	readonly cache: TransactionCache = {};

	/**
	 * List of tx type defining EIPs,
	 * e.g. 1559 (fee market) and 2930 (access lists)
	 * for FeeMarket1559Tx objects
	 */
	protected activeCapabilities: number[] = [];

	/**
	 * This constructor takes the values, validates them, assigns them and freezes the object.
	 *
	 * It is not recommended to use this constructor directly. Instead use
	 * the static factory methods to assist in creating a Transaction object from
	 * varying data types.
	 */
	public constructor(txData: TxData, opts: TxOptions = {}) {
		sharedConstructor(this, txData, opts);

		this.gasPrice = bytesToBigInt(toBytes(txData.gasPrice));
		valueOverflowCheck({ gasPrice: this.gasPrice });

		// Everything from BaseTransaction done here
		this.common.updateParams(opts.params ?? paramsTx); // TODO should this move higher?

		const chainId = validateVAndExtractChainID(this.common, this.v);
		if (chainId !== undefined && chainId !== this.common.chainId()) {
			throw new Error(
				`Common chain ID ${this.common.chainId} not matching the derived chain ID ${chainId}`,
			);
		}

		this.keccakFunction = this.common.customCrypto.keccak256 ?? keccak256;

		if (this.gasPrice * this.gasLimit > MAX_INTEGER) {
			throw new Error(
				"gas limit * gasPrice cannot exceed MAX_INTEGER (2^256-1)",
			);
		}

		const freeze = opts?.freeze ?? true;
		if (freeze) {
			Object.freeze(this);
		}
	}

	isSigned(): boolean {
		return Legacy.isSigned(this);
	}

	/**
	 * Computes the effective priority fee for this legacy transaction, optionally considering a base fee.
	 * @param baseFee - Optional base fee used on networks that emulate 1559-style pricing
	 * @returns Priority fee portion denominated in wei
	 */
	getEffectivePriorityFee(baseFee?: bigint): bigint {
		return Legacy.getEffectivePriorityFee(this.gasPrice, baseFee);
	}

	/**
	 * Returns a Uint8Array Array of the raw Bytes of the legacy transaction, in order.
	 *
	 * Format: `[nonce, gasPrice, gasLimit, to, value, data, v, r, s]`
	 *
	 * For legacy txs this is also the correct format to add transactions
	 * to a block with {@link createBlockFromBytesArray} (use the `serialize()` method
	 * for typed txs).
	 *
	 * For an unsigned tx this method returns the empty Bytes values
	 * for the signature parameters `v`, `r` and `s`. For an EIP-155 compliant
	 * representation have a look at {@link Transaction.getMessageToSign}.
	 */
	raw(): TxValuesArray {
		return [
			bigIntToUnpaddedBytes(this.nonce),
			bigIntToUnpaddedBytes(this.gasPrice),
			bigIntToUnpaddedBytes(this.gasLimit),
			this.to !== undefined ? this.to.bytes : new Uint8Array(0),
			bigIntToUnpaddedBytes(this.value),
			this.data,
			this.v !== undefined ? bigIntToUnpaddedBytes(this.v) : new Uint8Array(0),
			this.r !== undefined ? bigIntToUnpaddedBytes(this.r) : new Uint8Array(0),
			this.s !== undefined ? bigIntToUnpaddedBytes(this.s) : new Uint8Array(0),
		] as Uint8Array[];
	}

	serialize(): Uint8Array {
		return RLP.encode(this.raw());
	}

	/**
	 * Returns the raw unsigned tx, which can be used
	 * to sign the transaction (e.g. for sending to a hardware wallet).
	 *
	 * Note: the raw message message format for the legacy tx is not RLP encoded
	 * and you might need to do yourself with:
	 *
	 * ```javascript
	 * import { RLP } from '@ethereumjs/rlp'
	 * const message = tx.getMessageToSign()
	 * const serializedMessage = RLP.encode(message)) // use this for the HW wallet input
	 * ```
	 * @returns Array representing the unsigned transaction fields
	 */
	getMessageToSign(): Uint8Array[] {
		return [
			bigIntToUnpaddedBytes(this.nonce),
			bigIntToUnpaddedBytes(this.gasPrice),
			bigIntToUnpaddedBytes(this.gasLimit),
			this.to !== undefined ? this.to.bytes : new Uint8Array(0),
			bigIntToUnpaddedBytes(this.value),
			this.data,
		] as Uint8Array[];
	}

	/**
	 * Returns the hashed serialized unsigned tx, which can be used
	 * to sign the transaction (e.g. for sending to a hardware wallet).
	 * @returns Hash of the unsigned transaction payload
	 */
	getHashedMessageToSign() {
		const message = this.getMessageToSign();
		return this.keccakFunction(RLP.encode(message));
	}

	/**
	 * The amount of gas paid for the data in this tx
	 */
	getDataGas(): bigint {
		return Legacy.getDataGas(this);
	}

	// TODO figure out if this is necessary
	/**
	 * If the tx's `to` is to the creation address
	 */
	toCreationAddress(): boolean {
		return Legacy.toCreationAddress(this);
	}

	/**
	 * The minimum gas limit which the tx to have to be valid.
	 * This covers costs as the standard fee (21000 gas), the data fee (paid for each calldata byte),
	 * the optional creation fee (if the transaction creates a contract), and if relevant the gas
	 * to be paid for access lists (EIP-2930) and authority lists (EIP-7702).
	 */
	getIntrinsicGas(): bigint {
		return Legacy.getIntrinsicGas(this);
	}
	/**
	 * The up front amount that an account must have for this transaction to be valid
	 */
	getUpfrontCost(): bigint {
		return this.gasLimit * this.gasPrice + this.value;
	}

	/**
	 * Computes a sha3-256 hash of the serialized tx.
	 *
	 * This method can only be used for signed txs (it throws otherwise).
	 * Use {@link Transaction.getMessageToSign} to get a tx hash for the purpose of signing.
	 * @returns Hash of the serialized signed transaction
	 */
	hash(): Uint8Array {
		return Legacy.hash(this);
	}

	/**
	 * Computes a sha3-256 hash which can be used to verify the signature
	 * @returns Hash used when verifying the signature
	 */
	getMessageToVerifySignature() {
		if (!this.isSigned()) {
			const msg = Legacy.errorMsg(this, "This transaction is not signed");
			throw new Error(msg);
		}
		return this.getHashedMessageToSign();
	}

	/**
	 * Returns the public key of the sender
	 * @returns Sender public key
	 */
	getSenderPublicKey(): Uint8Array {
		return Legacy.getSenderPublicKey(this);
	}

	/**
	 * Adds a signature (or replaces an existing one) and returns a new transaction instance.
	 * @param v - Recovery parameter, potentially unconverted when `convertV` is false
	 * @param r - `r` value of the signature
	 * @param s - `s` value of the signature
	 * @param convertV - When true, converts the recovery ID into the appropriate legacy `v`
	 * @returns A new `LegacyTx` that includes the provided signature
	 */
	addSignature(
		v: bigint,
		r: Uint8Array | bigint,
		s: Uint8Array | bigint,
		// convertV is `true` when called from `sign`
		// This is used to convert the `v` output from `ecsign` (0 or 1) to the values used for legacy txs:
		// 27 or 28 for non-EIP-155 protected txs
		// 35 or 36 + chainId * 2 for EIP-155 protected txs
		// See: https://eips.ethereum.org/EIPS/eip-155
		convertV: boolean = false,
	): LegacyTx {
		r = toBytes(r);
		s = toBytes(s);

		if (convertV) {
			v += BigInt(27);
		}

		const opts = { ...this.txOptions, common: this.common };

		return createLegacyTx(
			{
				nonce: this.nonce,
				gasPrice: this.gasPrice,
				gasLimit: this.gasLimit,
				to: this.to,
				value: this.value,
				data: this.data,
				v,
				r: bytesToBigInt(r),
				s: bytesToBigInt(s),
			},
			opts,
		);
	}

	/**
	 * Returns an object with the JSON representation of the transaction.
	 * @returns JSON encoding of the transaction
	 */
	toJSON(): JSONTx {
		// TODO this is just copied. Make this execution-api compliant

		const baseJSON = getBaseJSON(this) as JSONTx;
		baseJSON.gasPrice = bigIntToHex(this.gasPrice);

		return baseJSON;
	}

	/**
	 * Validates the transaction and returns any encountered errors.
	 * @returns Array containing validation error messages
	 */
	getValidationErrors(): string[] {
		return Legacy.getValidationErrors(this);
	}

	/**
	 * Determines whether the transaction passes all validation checks.
	 * @returns true if no validation errors were found
	 */
	isValid(): boolean {
		return Legacy.isValid(this);
	}

	/**
	 * Checks whether the stored signature can be successfully verified.
	 * @returns true if the signature is valid
	 */
	verifySignature(): boolean {
		return Legacy.verifySignature(this);
	}

	/**
	 * Returns the recovered sender address.
	 * @returns Sender {@link Address}
	 */
	getSenderAddress(): Address {
		return Legacy.getSenderAddress(this);
	}

	/**
	 * Signs the transaction with the provided private key and returns the new signed instance.
	 * @param privateKey - 32-byte private key used to sign the transaction
	 * @param extraEntropy - Optional entropy passed to the signing routine
	 * @returns A new signed `LegacyTx`
	 */
	sign(
		privateKey: Uint8Array,
		extraEntropy: Uint8Array | boolean = false,
	): LegacyTx {
		return Legacy.sign(this, privateKey, extraEntropy) as LegacyTx;
	}

	/**
	 * Return a compact error string representation of the object
	 * @returns Human-readable error summary
	 */
	public errorStr() {
		let errorStr = Legacy.getSharedErrorPostfix(this);
		errorStr += ` gasPrice=${this.gasPrice}`;
		return errorStr;
	}
}
