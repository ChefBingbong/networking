// src/blockchain/evm/interpreter.ts

import type { StateManagerState } from "../state/state-manager";
import { getContractStorage, putContractStorage } from "../state/state-manager";
import type { Address, Hash } from "../types";
import { hexToBytes, padTo32Bytes } from "../utils";
import type { EVMExecutionState } from "./opcodes";
import { memoryExpand, OPCODES } from "./opcodes";

export interface InterpreterState {
	pc: number;
	code: Uint8Array;
	gas: bigint;
	stack: bigint[];
	memory: Uint8Array;
	returnData: Uint8Array;
	stopped: boolean;
	reverted: boolean;
	stateManager: StateManagerState;
	contractAddress: Address;
	callerAddress?: Address;
	evmCall?: (
		to: Address,
		value: bigint,
		data: Uint8Array,
		gasLimit: bigint,
		from: Address,
	) => { success: boolean; returnData: Uint8Array; gasUsed: bigint };
	evmCreate?: (
		value: bigint,
		initCode: Uint8Array,
		gasLimit: bigint,
		from: Address,
	) => { success: boolean; returnData: Uint8Array; gasUsed: bigint };
}

export function interpret(
	state: InterpreterState,
	input: Uint8Array,
): InterpreterState {
	// Initialize memory with input if provided
	if (input.length > 0) {
		state.memory = memoryExpand(state.memory, 0n, BigInt(input.length));
		state.memory.set(input, 0);
	}

	while (!state.stopped && state.pc < state.code.length) {
		const opcode = state.code[state.pc];
		if (opcode === undefined) {
			console.log(
				`[interpret] Undefined opcode at PC ${state.pc}, code length: ${state.code.length}`,
			);
			break;
		}

		const op = OPCODES.get(opcode);
		if (!op) {
			// Invalid opcode
			console.log(
				`[interpret] Invalid opcode 0x${opcode.toString(16)} at PC ${state.pc}`,
			);
			state.reverted = true;
			state.stopped = true;
			break;
		}

		// Calculate gas cost
		let gasCost: number;
		if (typeof op.gas === "function") {
			gasCost = op.gas(state.stack, state.memory);
		} else {
			gasCost = op.gas;
		}

		// Check gas
		if (state.gas < BigInt(gasCost)) {
			state.reverted = true;
			state.stopped = true;
			break;
		}

		state.gas -= BigInt(gasCost);

		// Execute opcode
		try {
			// For SSTORE and SLOAD, peek at stack values BEFORE execution
			// because op.execute will pop them, and we need them for state manager access
			let sstoreKey: bigint | undefined;
			let sstoreValue: bigint | undefined;
			let sloadKey: bigint | undefined;

			if (opcode === 0x55 && state.stack.length >= 2) {
				// SSTORE - peek at value (top) and key (second) before they're popped
				sstoreValue = state.stack[state.stack.length - 1];
				sstoreKey = state.stack[state.stack.length - 2];
			} else if (opcode === 0x54 && state.stack.length >= 1) {
				// SLOAD - peek at key before it's popped
				sloadKey = state.stack[state.stack.length - 1];
			}

			const execState: EVMExecutionState = {
				pc: state.pc,
				code: state.code,
				gas: state.gas,
				stack: state.stack,
				memory: state.memory,
				returnData: state.returnData,
				stopped: state.stopped,
				reverted: state.reverted,
				evmCall: state.evmCall,
				evmCreate: state.evmCreate,
				contractAddress: state.contractAddress,
				callerAddress: state.callerAddress,
			};

			op.execute(execState, state.stack, state.memory);

			// Update state from execution
			state.pc = execState.pc;
			state.gas = execState.gas;
			state.memory = execState.memory;
			state.returnData = execState.returnData;
			state.stopped = execState.stopped;
			state.reverted = execState.reverted;

			// Handle special opcodes that need state manager access
			if (
				opcode === 0x55 &&
				sstoreKey !== undefined &&
				sstoreValue !== undefined
			) {
				// SSTORE - write to contract storage using peeked values
				const key = padTo32Bytes(hexToBytes(sstoreKey.toString(16)));
				const value = padTo32Bytes(hexToBytes(sstoreValue.toString(16)));
				putContractStorage(
					state.stateManager,
					state.contractAddress,
					`0x${Buffer.from(key).toString("hex")}` as Hash,
					`0x${Buffer.from(value).toString("hex")}` as Hash,
				);
			} else if (opcode === 0x54 && sloadKey !== undefined) {
				// SLOAD - read from contract storage and replace placeholder on stack
				const key = padTo32Bytes(hexToBytes(sloadKey.toString(16)));
				const value = getContractStorage(
					state.stateManager,
					state.contractAddress,
					`0x${Buffer.from(key).toString("hex")}` as Hash,
				);
				// Replace the placeholder value that was pushed by op.execute
				if (state.stack.length > 0) {
					state.stack[state.stack.length - 1] = BigInt(value);
				}
			}

			// Increment PC (unless opcode modified it, like PUSH)
			if (opcode < 0x60 || opcode > 0x7f) {
				state.pc++;
			} else {
				// PUSH opcodes already advanced PC
				state.pc++;
			}
		} catch (error) {
			// Execution error
			console.log(
				`[interpret] Exception executing opcode 0x${opcode.toString(16)} (${op.name}) at PC ${state.pc}:`,
				error,
			);
			state.reverted = true;
			state.stopped = true;
			break;
		}
	}

	return state;
}

export function chargeGas(state: InterpreterState, gasCost: bigint): void {
	if (state.gas < gasCost) {
		throw new Error("Out of gas");
	}
	state.gas -= gasCost;
}

export function checkGas(state: InterpreterState, required: bigint): boolean {
	return state.gas >= required;
}
