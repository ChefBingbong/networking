// src/blockchain/evm/evm.ts

import type { StateManagerState } from "../state/state-manager";
import {
	checkpoint,
	getAccount,
	getAccountCode,
	putAccount,
	putAccountCode,
	revertToCheckpoint,
} from "../state/state-manager";
import type { Address, Block, Log, Transaction } from "../types";
import { hashToHex, keccak256Hash } from "../utils";
import { type InterpreterState, interpret } from "./interpreter";
import { executePrecompile } from "./precompiles";

export interface EVMState {
	stateManager: StateManagerState;
	block: Block;
	tx: Transaction;
	gasUsed: bigint;
	logs: Log[];
	returnData: Uint8Array;
}

export interface EVMResult {
	success: boolean;
	returnData: Uint8Array;
	gasUsed: bigint;
	logs: Log[];
}

export function evmRun(
	state: EVMState,
	code: Uint8Array,
	input: Uint8Array,
	gasLimit: bigint,
	contractAddress: Address,
	callerAddress?: Address,
): EVMResult {
	const interpreterState: InterpreterState = {
		pc: 0,
		code,
		gas: gasLimit,
		stack: [],
		memory: new Uint8Array(0),
		returnData: new Uint8Array(0),
		stopped: false,
		reverted: false,
		stateManager: state.stateManager,
		contractAddress,
		callerAddress,
		evmCall: (to, value, data, gas, from) => {
			const callResult = evmCall(state, to, value, data, gas, from);
			return {
				success: callResult.success,
				returnData: callResult.returnData,
				gasUsed: callResult.gasUsed,
			};
		},
		evmCreate: (value, initCode, gas, from) => {
			const createResult = evmCreate(state, value, initCode, gas, from);
			return {
				success: createResult.success,
				returnData: createResult.returnData,
				gasUsed: createResult.gasUsed,
			};
		},
	};

	const result = interpret(interpreterState, input);

	if (result.reverted) {
		console.log(
			`[evmRun] Execution reverted, returnData length: ${result.returnData.length}, PC: ${result.pc}`,
		);
	}
	if (!result.stopped && result.pc >= code.length) {
		console.log(
			`[evmRun] Execution reached end of code without stopping, PC: ${result.pc}, code length: ${code.length}`,
		);
	}

	return {
		success: !result.reverted && result.stopped,
		returnData: result.returnData,
		gasUsed: gasLimit - result.gas,
		logs: state.logs,
	};
}

export function evmCall(
	state: EVMState,
	to: Address,
	value: bigint,
	data: Uint8Array,
	gasLimit: bigint,
	from: Address,
): EVMResult {
	console.log(
		`[evmCall] Called from ${from} to ${to} with value ${value.toString()}`,
	);
	checkpoint(state.stateManager);

	try {
		// Transfer value
		const fromAccount = getAccount(state.stateManager, from);
		const toAccount = getAccount(state.stateManager, to);

		console.log(
			`[evmCall] Before transfer - From balance: ${fromAccount.balance.toString()}, To balance: ${toAccount.balance.toString()}`,
		);

		if (fromAccount.balance < value) {
			console.log(
				`[evmCall] Insufficient balance for transfer: ${fromAccount.balance.toString()} < ${value.toString()}`,
			);
			revertToCheckpoint(state.stateManager);
			return {
				success: false,
				returnData: new Uint8Array(0),
				gasUsed: 0n,
				logs: [],
			};
		}

		fromAccount.balance -= value;
		toAccount.balance += value;
		putAccount(state.stateManager, from, fromAccount);
		putAccount(state.stateManager, to, toAccount);
		console.log(
			`[evmCall] Transferred ${value.toString()} - From balance: ${fromAccount.balance.toString()}, To balance: ${toAccount.balance.toString()}`,
		);

		// Check if it's a precompile
		if (to.startsWith("0x000000000000000000000000000000000000000")) {
			console.log(`[evmCall] Executing precompile at ${to}`);
			const precompileResult = executePrecompile(to, data, gasLimit);
			if (!precompileResult.success) {
				console.log(`[evmCall] Precompile execution failed`);
				revertToCheckpoint(state.stateManager);
			}
			// Don't commit here - let processTransaction handle it
			return {
				success: precompileResult.success,
				returnData: precompileResult.returnData,
				gasUsed: precompileResult.gasUsed,
				logs: [],
			};
		}

		// Get contract code
		const code = getAccountCode(state.stateManager, to);
		if (code.length === 0) {
			// EOA call - just transfer value
			console.log(`[evmCall] EOA call - no contract code, returning success`);
			// Don't commit here - let processTransaction handle it
			// The checkpoint will be committed by processTransaction if successful
			return {
				success: true,
				returnData: new Uint8Array(0),
				gasUsed: 21000n, // Base gas cost for EOA transfer
				logs: [],
			};
		}

		// Execute contract
		console.log(`[evmCall] Executing contract code (${code.length} bytes)`);
		const result = evmRun(state, code, data, gasLimit, to, from);
		state.gasUsed += result.gasUsed;

		if (!result.success) {
			console.log(`[evmCall] Contract execution failed, reverting checkpoint`);
			revertToCheckpoint(state.stateManager);
		} else {
			console.log(
				`[evmCall] Contract execution succeeded, gasUsed: ${result.gasUsed.toString()}`,
			);
		}
		// Don't commit here - let processTransaction handle it

		return result;
	} catch (error) {
		console.log(`[evmCall] Exception occurred:`, error);
		revertToCheckpoint(state.stateManager);
		return {
			success: false,
			returnData: new Uint8Array(0),
			gasUsed: 0n,
			logs: [],
		};
	}
}

export function evmCreate(
	state: EVMState,
	value: bigint,
	initCode: Uint8Array,
	gasLimit: bigint,
	from: Address,
): EVMResult {
	console.log(
		`[evmCreate] Creating contract from ${from} with value ${value.toString()}, initCode length: ${initCode.length}`,
	);
	checkpoint(state.stateManager);

	try {
		// Create contract address
		const fromAccount = getAccount(state.stateManager, from);
		const nonce = fromAccount.nonce;
		const contractAddress = createContractAddress(from, nonce);
		console.log(
			`[evmCreate] Contract address will be ${contractAddress} (nonce: ${nonce.toString()})`,
		);

		// Transfer value if any
		if (value > 0n) {
			const fromAcc = getAccount(state.stateManager, from);
			const contractAcc = getAccount(state.stateManager, contractAddress);

			console.log(
				`[evmCreate] Transferring value ${value.toString()} to contract. From balance: ${fromAcc.balance.toString()}`,
			);

			if (fromAcc.balance < value) {
				console.log(
					`[evmCreate] Insufficient balance for value transfer: ${fromAcc.balance.toString()} < ${value.toString()}`,
				);
				revertToCheckpoint(state.stateManager);
				return {
					success: false,
					returnData: new Uint8Array(0),
					gasUsed: 0n,
					logs: [],
				};
			}

			fromAcc.balance -= value;
			contractAcc.balance += value;
			putAccount(state.stateManager, from, fromAcc);
			putAccount(state.stateManager, contractAddress, contractAcc);
			console.log(
				`[evmCreate] Transferred value. From balance: ${fromAcc.balance.toString()}, Contract balance: ${contractAcc.balance.toString()}`,
			);
		}

		// Execute init code
		console.log(`[evmCreate] Executing init code (${initCode.length} bytes)`);
		const result = evmRun(
			state,
			initCode,
			new Uint8Array(0),
			gasLimit,
			contractAddress,
			from,
		);

		if (!result.success) {
			console.log(
				`[evmCreate] Init code execution failed, reverting checkpoint`,
			);
			revertToCheckpoint(state.stateManager);
			return result;
		}

		console.log(
			`[evmCreate] Init code execution succeeded, storing contract code (${result.returnData.length} bytes)`,
		);
		// Store contract code
		putAccountCode(state.stateManager, contractAddress, result.returnData);

		// Increment sender nonce
		const oldNonce = fromAccount.nonce;
		fromAccount.nonce++;
		putAccount(state.stateManager, from, fromAccount);
		console.log(
			`[evmCreate] Incremented sender nonce from ${oldNonce.toString()} to ${fromAccount.nonce.toString()}`,
		);

		return {
			success: true,
			returnData: hexToBytes(contractAddress),
			gasUsed: result.gasUsed,
			logs: result.logs,
		};
	} catch (error) {
		console.log(`[evmCreate] Exception occurred:`, error);
		revertToCheckpoint(state.stateManager);
		return {
			success: false,
			returnData: new Uint8Array(0),
			gasUsed: 0n,
			logs: [],
		};
	}
}

export function evmExecute(
	state: EVMState,
	tx: Transaction,
	from: Address,
): EVMResult {
	console.log(
		`[evmExecute] Starting execution for tx from ${from} to ${tx.to ?? "CREATE"}`,
	);

	// Get transaction gas price
	const gasPrice =
		tx.type === "legacy" ? (tx.gasPrice ?? 0n) : (tx.maxFeePerGas ?? 0n);

	// Calculate gas limit
	const gasLimit = tx.gasLimit;

	// Check sender has enough balance (value + gas)
	const senderAccount = getAccount(state.stateManager, from);
	const gasCost = gasLimit * gasPrice;
	const totalCost = tx.value + gasCost;

	console.log(
		`[evmExecute] Sender balance: ${senderAccount.balance.toString()}, totalCost: ${totalCost.toString()} (value: ${tx.value.toString()}, gasCost: ${gasCost.toString()})`,
	);

	if (senderAccount.balance < totalCost) {
		console.log(
			`[evmExecute] Insufficient balance: ${senderAccount.balance.toString()} < ${totalCost.toString()}`,
		);
		return {
			success: false,
			returnData: new Uint8Array(0),
			gasUsed: 0n,
			logs: [],
		};
	}

	// Don't deduct here - let evmCall/evmCreate handle the value transfer
	// We'll deduct gas cost after execution based on actual gas used
	const oldNonce = senderAccount.nonce;
	senderAccount.nonce++;
	putAccount(state.stateManager, from, senderAccount);
	console.log(
		`[evmExecute] Incremented nonce from ${oldNonce.toString()} to ${senderAccount.nonce.toString()}`,
	);

	// Execute transaction (this will handle value transfer)
	let result: EVMResult;
	if (!tx.to) {
		// Contract creation
		console.log(
			`[evmExecute] Creating contract with value ${tx.value.toString()}`,
		);
		result = evmCreate(state, tx.value, tx.data, gasLimit, from);
	} else {
		// Contract call or transfer
		console.log(
			`[evmExecute] Calling ${tx.to} with value ${tx.value.toString()}`,
		);
		result = evmCall(state, tx.to, tx.value, tx.data, gasLimit, from);
	}

	if (!result.success) {
		console.log(
			`[evmExecute] Transaction execution failed, gasUsed: ${result.gasUsed.toString()}`,
		);
		return result;
	}

	console.log(
		`[evmExecute] Transaction execution succeeded, gasUsed: ${result.gasUsed.toString()}`,
	);

	// Deduct actual gas used from sender and give to beneficiary
	const actualGasCost = result.gasUsed * gasPrice;
	const senderFinal = getAccount(state.stateManager, from);
	const senderBalanceBeforeGas = senderFinal.balance;
	senderFinal.balance -= actualGasCost;
	putAccount(state.stateManager, from, senderFinal);
	console.log(
		`[evmExecute] Deducted gas cost ${actualGasCost.toString()} from sender. Balance: ${senderBalanceBeforeGas.toString()} -> ${senderFinal.balance.toString()}`,
	);

	const beneficiaryAccount = getAccount(
		state.stateManager,
		state.block.header.beneficiary,
	);
	const beneficiaryBalanceBefore = beneficiaryAccount.balance;
	beneficiaryAccount.balance += actualGasCost;
	putAccount(
		state.stateManager,
		state.block.header.beneficiary,
		beneficiaryAccount,
	);
	console.log(
		`[evmExecute] Added gas cost ${actualGasCost.toString()} to beneficiary ${state.block.header.beneficiary}. Balance: ${beneficiaryBalanceBefore.toString()} -> ${beneficiaryAccount.balance.toString()}`,
	);

	return result;
}

function createContractAddress(sender: Address, nonce: bigint): Address {
	const rlp = new TextEncoder().encode(`${sender}:${nonce}`);
	const hash = keccak256Hash(rlp);
	return hashToHex(hash.slice(-20)) as Address;
}

function hexToBytes(hex: string): Uint8Array {
	const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
	return Uint8Array.from(Buffer.from(cleanHex, "hex"));
}
