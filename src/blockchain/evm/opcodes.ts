// src/blockchain/evm/opcodes.ts

export interface Opcode {
	name: string;
	code: number;
	gas: number | ((stack: bigint[], memory: Uint8Array) => number);
	execute: (
		state: EVMExecutionState,
		stack: bigint[],
		memory: Uint8Array,
	) => void;
}

export interface EVMExecutionState {
	pc: number;
	code: Uint8Array;
	gas: bigint;
	stack: bigint[];
	memory: Uint8Array;
	returnData: Uint8Array;
	stopped: boolean;
	reverted: boolean;
	// Callbacks for CALL/CREATE/DELEGATECALL
	evmCall?: (
		to: string,
		value: bigint,
		data: Uint8Array,
		gasLimit: bigint,
		from: string,
	) => { success: boolean; returnData: Uint8Array; gasUsed: bigint };
	evmCreate?: (
		value: bigint,
		initCode: Uint8Array,
		gasLimit: bigint,
		from: string,
	) => { success: boolean; returnData: Uint8Array; gasUsed: bigint };
	contractAddress?: string;
	callerAddress?: string;
}

// Stack operations
export function stackPush(stack: bigint[], value: bigint): void {
	if (stack.length >= 1024) {
		throw new Error("Stack overflow");
	}
	stack.push(value);
}

export function stackPop(stack: bigint[]): bigint {
	if (stack.length === 0) {
		throw new Error("Stack underflow");
	}
	return stack.pop()!;
}

export function stackPeek(stack: bigint[], depth: number): bigint {
	if (stack.length < depth + 1) {
		throw new Error("Stack underflow");
	}
	return stack[stack.length - 1 - depth]!;
}

// Memory operations
export function memoryExpand(
	memory: Uint8Array,
	offset: bigint,
	length: bigint,
): Uint8Array {
	const newSize = Number(offset + length);
	if (newSize > memory.length) {
		const expanded = new Uint8Array(
			Math.ceil(newSize / 32) * 32, // Round up to 32-byte word
		);
		expanded.set(memory);
		return expanded;
	}
	return memory;
}

export function memoryStore(
	memory: Uint8Array,
	offset: bigint,
	value: bigint,
	length: number = 32,
): Uint8Array {
	const mem = memoryExpand(memory, offset, BigInt(length));
	const bytes = bigIntToBytes(value);
	const start = Number(offset);
	for (let i = 0; i < length && i < bytes.length; i++) {
		mem[start + length - 1 - i] = bytes[bytes.length - 1 - i] ?? 0;
	}
	return mem;
}

export function memoryLoad(memory: Uint8Array, offset: bigint): bigint {
	const mem = memoryExpand(memory, offset, 32n);
	const start = Number(offset);
	const bytes = mem.slice(start, start + 32);
	return bytesToBigInt(bytes);
}

function bigIntToBytes(value: bigint): Uint8Array {
	if (value === 0n) {
		return new Uint8Array(32).fill(0);
	}
	const hex = value.toString(16);
	const padded = hex.padStart(64, "0");
	return Uint8Array.from(Buffer.from(padded, "hex"));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
	if (bytes.length === 0) return 0n;
	return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

// Core opcodes implementation
export const OPCODES: Map<number, Opcode> = new Map();

// STOP
OPCODES.set(0x00, {
	name: "STOP",
	code: 0x00,
	gas: 0,
	execute: (state) => {
		state.stopped = true;
	},
});

// ADD
OPCODES.set(0x01, {
	name: "ADD",
	code: 0x01,
	gas: 3,
	execute: (state, stack) => {
		const a = stackPop(stack);
		const b = stackPop(stack);
		stackPush(
			stack,
			(a + b) &
				BigInt(
					"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				),
		);
	},
});

// MUL
OPCODES.set(0x02, {
	name: "MUL",
	code: 0x02,
	gas: 5,
	execute: (state, stack) => {
		const a = stackPop(stack);
		const b = stackPop(stack);
		stackPush(
			stack,
			(a * b) &
				BigInt(
					"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				),
		);
	},
});

// SUB
OPCODES.set(0x03, {
	name: "SUB",
	code: 0x03,
	gas: 3,
	execute: (state, stack) => {
		const a = stackPop(stack);
		const b = stackPop(stack);
		const result =
			a >= b
				? a - b
				: BigInt(
						"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
					) -
					(b - a) +
					1n;
		stackPush(stack, result);
	},
});

// DIV
OPCODES.set(0x04, {
	name: "DIV",
	code: 0x04,
	gas: 5,
	execute: (state, stack) => {
		const a = stackPop(stack);
		const b = stackPop(stack);
		stackPush(stack, b === 0n ? 0n : a / b);
	},
});

// MOD
OPCODES.set(0x06, {
	name: "MOD",
	code: 0x06,
	gas: 5,
	execute: (state, stack) => {
		const a = stackPop(stack);
		const b = stackPop(stack);
		stackPush(stack, b === 0n ? 0n : a % b);
	},
});

// EXP
OPCODES.set(0x0a, {
	name: "EXP",
	code: 0x0a,
	gas: (stack) => {
		const exponent = stack[stack.length - 1];
		if (!exponent) return 10;
		const bitLength = exponent.toString(2).length;
		return 10 + bitLength * 10;
	},
	execute: (state, stack) => {
		const base = stackPop(stack);
		const exponent = stackPop(stack);
		// Simple implementation - in production would use modular exponentiation
		let result = 1n;
		for (let i = 0n; i < exponent && i < 256n; i++) {
			result =
				(result * base) &
				BigInt(
					"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				);
		}
		stackPush(stack, result);
	},
});

// POP
OPCODES.set(0x50, {
	name: "POP",
	code: 0x50,
	gas: 2,
	execute: (state, stack) => {
		stackPop(stack);
	},
});

// PUSH1-PUSH32
for (let i = 0x60; i <= 0x7f; i++) {
	const pushSize = i - 0x5f;
	OPCODES.set(i, {
		name: `PUSH${pushSize}`,
		code: i,
		gas: 3,
		execute: (state) => {
			const bytes = new Uint8Array(pushSize);
			for (
				let j = 0;
				j < pushSize && state.pc + 1 + j < state.code.length;
				j++
			) {
				bytes[j] = state.code[state.pc + 1 + j] ?? 0;
			}
			state.pc += pushSize; // Skip the pushed bytes
			stackPush(state.stack, bytesToBigInt(bytes));
		},
	});
}

// DUP1-DUP16
for (let i = 0x80; i <= 0x8f; i++) {
	const dupDepth = i - 0x7f;
	OPCODES.set(i, {
		name: `DUP${dupDepth}`,
		code: i,
		gas: 3,
		execute: (state, stack) => {
			const value = stackPeek(stack, dupDepth - 1);
			stackPush(stack, value);
		},
	});
}

// SWAP1-SWAP16
for (let i = 0x90; i <= 0x9f; i++) {
	const swapDepth = i - 0x8f;
	OPCODES.set(i, {
		name: `SWAP${swapDepth}`,
		code: i,
		gas: 3,
		execute: (state, stack) => {
			const top = stackPop(stack);
			const other = stackPeek(stack, swapDepth);
			stack[stack.length - 1 - swapDepth] = top;
			stackPush(stack, other);
		},
	});
}

// LOG0-LOG4
for (let i = 0xa0; i <= 0xa4; i++) {
	const logNum = i - 0xa0;
	OPCODES.set(i, {
		name: `LOG${logNum}`,
		code: i,
		gas: (stack, memory) => {
			const offset = stack[stack.length - 1];
			const length = stack[stack.length - 2];
			if (!offset || !length) return 375;
			const memCost = Math.ceil(Number(length) / 32) * 8;
			return 375 + memCost + logNum * 375;
		},
		execute: (state, stack, memory) => {
			// Extract topics and data
			const offset = stackPop(stack);
			const length = stackPop(stack);
			const topics: bigint[] = [];
			for (let j = 0; j < logNum; j++) {
				topics.push(stackPop(stack));
			}
			// In full implementation, would emit log event
			// For now, just consume the stack items
		},
	});
}

// SSTORE
OPCODES.set(0x55, {
	name: "SSTORE",
	code: 0x55,
	gas: 20000, // Simplified - actual gas depends on storage state
	execute: (state, stack) => {
		// SSTORE pops key and value but doesn't modify stack otherwise
		// The actual storage write is handled in the interpreter's special handling
		// We just pop here to consume the stack items
		const key = stackPop(stack);
		const value = stackPop(stack);
		// Store these in the execution state for the interpreter to handle
		// Actually, we can't access stateManager here, so we need to handle it in interpreter
	},
});

// SLOAD
OPCODES.set(0x54, {
	name: "SLOAD",
	code: 0x54,
	gas: 200,
	execute: (state, stack) => {
		// In full implementation, would call state manager
		const key = stackPop(stack);
		stackPush(stack, 0n); // Placeholder - actual value from state
	},
});

// MLOAD
OPCODES.set(0x51, {
	name: "MLOAD",
	code: 0x51,
	gas: 3,
	execute: (state, stack, memory) => {
		const offset = stackPop(stack);
		const value = memoryLoad(memory, offset);
		stackPush(stack, value);
		state.memory = memoryExpand(memory, offset, 32n);
	},
});

// MSTORE
OPCODES.set(0x52, {
	name: "MSTORE",
	code: 0x52,
	gas: 3,
	execute: (state, stack, memory) => {
		const offset = stackPop(stack);
		const value = stackPop(stack);
		state.memory = memoryStore(memory, offset, value, 32);
	},
});

// MSTORE8
OPCODES.set(0x53, {
	name: "MSTORE8",
	code: 0x53,
	gas: 3,
	execute: (state, stack, memory) => {
		const offset = stackPop(stack);
		const value = stackPop(stack);
		const mem = memoryExpand(memory, offset, 1n);
		mem[Number(offset)] = Number(value & 0xffn);
		state.memory = mem;
	},
});

// RETURN
OPCODES.set(0xf3, {
	name: "RETURN",
	code: 0xf3,
	gas: 0,
	execute: (state, stack, memory) => {
		const offset = stackPop(stack);
		const length = stackPop(stack);
		const mem = memoryExpand(memory, offset, length);
		state.returnData = mem.slice(Number(offset), Number(offset + length));
		state.stopped = true;
	},
});

// REVERT
OPCODES.set(0xfd, {
	name: "REVERT",
	code: 0xfd,
	gas: 0,
	execute: (state, stack, memory) => {
		const offset = stackPop(stack);
		const length = stackPop(stack);
		const mem = memoryExpand(memory, offset, length);
		state.returnData = mem.slice(Number(offset), Number(offset + length));
		state.reverted = true;
		state.stopped = true;
	},
});

// CALL
OPCODES.set(0xf1, {
	name: "CALL",
	code: 0xf1,
	gas: (stack) => {
		const value = stack[stack.length - 3];
		const gas = stack[stack.length - 1];
		let gasCost = 700n;
		if (value && value > 0n) {
			gasCost += 9000n; // Additional cost for value transfer
		}
		// Memory expansion cost would be added here
		return Number(gasCost);
	},
	execute: (state, stack, memory) => {
		if (!state.evmCall || !state.callerAddress) {
			stackPush(stack, 0n); // Failure
			return;
		}

		const gas = stackPop(stack);
		const to = stackPop(stack);
		const value = stackPop(stack);
		const argsOffset = stackPop(stack);
		const argsLength = stackPop(stack);
		const retOffset = stackPop(stack);
		const retLength = stackPop(stack);

		// Extract call data from memory
		const callData = memory.slice(
			Number(argsOffset),
			Number(argsOffset + argsLength),
		);

		// Convert address to hex string
		const toAddress = `0x${to.toString(16).padStart(40, "0")}`;

		// Execute call
		const result = state.evmCall(
			toAddress,
			value,
			callData,
			gas,
			state.callerAddress,
		);

		// Write return data to memory
		if (result.success && retLength > 0n) {
			const mem = memoryExpand(memory, retOffset, retLength);
			const copyLength = Math.min(Number(retLength), result.returnData.length);
			mem.set(result.returnData.slice(0, copyLength), Number(retOffset));
			state.memory = mem;
		}

		state.gas -= result.gasUsed;
		stackPush(stack, result.success ? 1n : 0n);
	},
});

// CREATE
OPCODES.set(0xf0, {
	name: "CREATE",
	code: 0xf0,
	gas: 32000,
	execute: (state, stack, memory) => {
		if (!state.evmCreate || !state.callerAddress) {
			stackPush(stack, 0n); // Failure
			return;
		}

		const value = stackPop(stack);
		const offset = stackPop(stack);
		const length = stackPop(stack);

		// Extract init code from memory
		const initCode = memory.slice(Number(offset), Number(offset + length));

		// Execute creation
		const result = state.evmCreate(
			value,
			initCode,
			state.gas,
			state.callerAddress,
		);

		state.gas -= result.gasUsed;

		if (result.success) {
			// Convert address to bigint
			const addressBytes = result.returnData.slice(-20);
			const addressBigInt = BigInt(
				`0x${Buffer.from(addressBytes).toString("hex")}`,
			);
			stackPush(stack, addressBigInt);
		} else {
			stackPush(stack, 0n);
		}
	},
});

// DELEGATECALL
OPCODES.set(0xf4, {
	name: "DELEGATECALL",
	code: 0xf4,
	gas: 700,
	execute: (state, stack, memory) => {
		if (!state.evmCall || !state.callerAddress || !state.contractAddress) {
			stackPush(stack, 0n); // Failure
			return;
		}

		const gas = stackPop(stack);
		const to = stackPop(stack);
		const argsOffset = stackPop(stack);
		const argsLength = stackPop(stack);
		const retOffset = stackPop(stack);
		const retLength = stackPop(stack);

		// Extract call data from memory
		const callData = memory.slice(
			Number(argsOffset),
			Number(argsOffset + argsLength),
		);

		// Convert address to hex string
		const toAddress = `0x${to.toString(16).padStart(40, "0")}`;

		// DELEGATECALL preserves msg.sender and msg.value from original call
		// Execute call with original caller (not contract address)
		const result = state.evmCall(
			toAddress,
			0n, // DELEGATECALL doesn't transfer value
			callData,
			gas,
			state.callerAddress, // Preserve original caller
		);

		// Write return data to memory
		if (result.success && retLength > 0n) {
			const mem = memoryExpand(memory, retOffset, retLength);
			const copyLength = Math.min(Number(retLength), result.returnData.length);
			mem.set(result.returnData.slice(0, copyLength), Number(retOffset));
			state.memory = mem;
		}

		state.gas -= result.gasUsed;
		stackPush(stack, result.success ? 1n : 0n);
	},
});

// STATICCALL
OPCODES.set(0xfa, {
	name: "STATICCALL",
	code: 0xfa,
	gas: 700,
	execute: (state, stack, memory) => {
		if (!state.evmCall || !state.callerAddress) {
			stackPush(stack, 0n); // Failure
			return;
		}

		const gas = stackPop(stack);
		const to = stackPop(stack);
		const argsOffset = stackPop(stack);
		const argsLength = stackPop(stack);
		const retOffset = stackPop(stack);
		const retLength = stackPop(stack);

		// Extract call data from memory
		const callData = memory.slice(
			Number(argsOffset),
			Number(argsOffset + argsLength),
		);

		// Convert address to hex string
		const toAddress = `0x${to.toString(16).padStart(40, "0")}`;

		// STATICCALL - no value transfer, read-only
		const result = state.evmCall(
			toAddress,
			0n,
			callData,
			gas,
			state.callerAddress,
		);

		// Write return data to memory
		if (result.success && retLength > 0n) {
			const mem = memoryExpand(memory, retOffset, retLength);
			const copyLength = Math.min(Number(retLength), result.returnData.length);
			mem.set(result.returnData.slice(0, copyLength), Number(retOffset));
			state.memory = mem;
		}

		state.gas -= result.gasUsed;
		stackPush(stack, result.success ? 1n : 0n);
	},
});
