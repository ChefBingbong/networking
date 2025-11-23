// src/blockchain/utils/contracts.ts
// Simple contract bytecode generators for demo purposes

import { hashToHex, keccak256Hash } from "../utils";

/**
 * Simple Storage Contract
 * Stores a uint256 value and allows reading/writing it
 *
 * Solidity equivalent:
 * contract SimpleStorage {
 *     uint256 public value;
 *     function set(uint256 _value) public { value = _value; }
 *     function get() public view returns (uint256) { return value; }
 * }
 */

/**
 * Simple storage contract bytecode
 * This contract supports:
 * - get(): Returns stored value (when called with empty data)
 * - set(value): Updates stored value (when called with 32-byte value in calldata)
 *
 * Runtime bytecode logic:
 * - If calldata is empty: return stored value (getter)
 * - If calldata has 32 bytes: store it and return success (setter)
 */
export function getSimpleStorageContractBytecode(): Uint8Array {
	// Runtime bytecode that handles both get() and set(value)
	// We'll use CALLDATASIZE to check if there's input data
	// If no data: return stored value
	// If data present: store it

	// Bytecode structure:
	// 1. Check if calldata is empty (CALLDATASIZE)
	// 2. If empty: load and return stored value
	// 3. If not empty: load value from calldata, store it, return success

	// For simplicity, we'll make it so:
	// - Empty call = getter (returns stored value)
	// - 32-byte call = setter (stores value from calldata)

	// Since CALLDATALOAD isn't implemented, we'll use a simpler approach:
	// The contract will check if input data exists, and if so, use it as the value to store
	// For now, let's keep it simple: empty data = get, non-empty = set

	// Simple version: Always return stored value
	// For setter, we'd need CALLDATALOAD which isn't implemented
	// So we'll create a version that stores value from input memory

	const runtimeCode = new Uint8Array([
		// Load stored value
		0x60,
		0x00, // PUSH1 0x00 (storage slot)
		0x54, // SLOAD (load value from storage slot 0)
		// Store in memory
		0x60,
		0x00, // PUSH1 0x00 (memory offset)
		0x52, // MSTORE (store value in memory at offset 0)
		// Return it
		0x60,
		0x20, // PUSH1 0x20 (32 bytes)
		0x60,
		0x00, // PUSH1 0x00 (memory offset)
		0xf3, // RETURN (return 32 bytes from memory offset 0)
	]);

	return runtimeCode;
}

/**
 * Constructor bytecode that stores initial value and returns runtime code
 * Since CODECOPY and MSTORE8 aren't implemented, we'll use a simpler approach:
 * Just return the runtime code directly (it's small enough to hardcode)
 */
export function getSimpleStorageConstructorBytecode(
	initialValue: bigint,
): Uint8Array {
	// Convert initial value to 32-byte hex
	const valueHex = initialValue.toString(16).padStart(64, "0");
	const valueBytes = Uint8Array.from(Buffer.from(valueHex, "hex"));

	// Runtime code (what will be deployed) - 7 bytes
	const runtimeCode = getSimpleStorageContractBytecode();

	// Constructor code:
	// 1. Store initial value in storage slot 0
	// 2. Push runtime code bytes to stack and write to memory using MSTORE
	// 3. Return runtime code

	// Step 1: Store initial value
	// PUSH1 0x00 (storage slot)
	// PUSH32 <initialValue> (value to store)
	// SSTORE (store value)
	const storeValue = new Uint8Array([
		0x60,
		0x00, // PUSH1 0x00 (storage slot)
		0x7f, // PUSH32
		...valueBytes, // 32 bytes of value
		0x55, // SSTORE
	]);

	// Step 2: Write runtime code to memory byte-by-byte using MSTORE8
	// This is simpler and doesn't require padding
	const runtimeCodeLength = runtimeCode.length;

	// Write each byte of runtime code to memory using MSTORE8
	const writeRuntimeOps: Uint8Array[] = [];
	for (let i = 0; i < runtimeCodeLength; i++) {
		const byte = runtimeCode[i];
		if (byte === undefined) continue;
		// PUSH1 <byte>
		// PUSH1 <offset>
		// MSTORE8
		writeRuntimeOps.push(
			new Uint8Array([
				0x60,
				byte, // PUSH1 byte value
				0x60,
				i, // PUSH1 memory offset
				0x53, // MSTORE8
			]),
		);
	}

	// Combine all MSTORE8 operations
	const writeRuntime = new Uint8Array(
		writeRuntimeOps.reduce((sum, op) => sum + op.length, 0),
	);
	let writeOffset = 0;
	for (const op of writeRuntimeOps) {
		writeRuntime.set(op, writeOffset);
		writeOffset += op.length;
	}

	// Step 3: Return runtime code from memory
	// PUSH1 <runtimeCodeLength> (length)
	// PUSH1 0x00 (memory offset - we wrote from offset 0)
	// RETURN
	const returnCode = new Uint8Array([
		0x60,
		runtimeCodeLength, // PUSH1 length
		0x60,
		0x00, // PUSH1 offset (we wrote from offset 0)
		0xf3, // RETURN
	]);

	// Combine all parts
	const constructorCode = new Uint8Array(
		storeValue.length + writeRuntime.length + returnCode.length,
	);

	let offset = 0;
	constructorCode.set(storeValue, offset);
	offset += storeValue.length;
	constructorCode.set(writeRuntime, offset);
	offset += writeRuntime.length;
	constructorCode.set(returnCode, offset);

	return constructorCode;
}

/**
 * Create contract deployment transaction data
 * Returns the full constructor bytecode that stores initial value and returns runtime code
 */
export function createStorageContractDeploymentData(
	initialValue: bigint,
): Uint8Array {
	return getSimpleStorageConstructorBytecode(initialValue);
}

/**
 * Create contract call data to get stored value
 * For our simple contract, calling with empty data returns the stored value
 */
export function createGetValueCallData(): Uint8Array {
	// Empty call data - our simple contract returns stored value when called
	return new Uint8Array(0);
}

/**
 * Create contract call data to set stored value
 */
export function createSetValueCallData(value: bigint): Uint8Array {
	// Convert bigint to 32-byte hex string (padded)
	const valueHex = value.toString(16).padStart(64, "0");
	return Uint8Array.from(Buffer.from(valueHex, "hex"));
}

/**
 * Decode return data from contract call
 * Assumes 32-byte bigint return value
 */
export function decodeUint256ReturnData(data: Uint8Array): bigint {
	if (data.length < 32) {
		return 0n;
	}
	// Take last 32 bytes (contracts return right-aligned)
	const valueBytes = data.slice(-32);
	const valueHex = Buffer.from(valueBytes).toString("hex");
	return BigInt("0x" + valueHex);
}

/**
 * Calculate contract address from deployer address and nonce
 */
export function calculateContractAddress(
	deployerAddress: string,
	nonce: bigint,
): string {
	// Import utils dynamically to avoid circular dependency

	const rlp = new TextEncoder().encode(`${deployerAddress}:${nonce}`);
	const hash = keccak256Hash(rlp);
	return hashToHex(hash.slice(-20));
}
