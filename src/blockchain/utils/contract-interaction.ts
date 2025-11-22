// src/blockchain/utils/contract-interaction.ts
// Helper functions for interacting with smart contracts

import type { BlockchainClientState } from "../client/client";
import { clientCall, clientSendTransaction } from "../client/client";
import { getAccount } from "../state/state-manager";
import { createTransaction, signTransaction } from "../tx/transaction";
import type { Address, Wei } from "../types";
import { createGetValueCallData, decodeUint256ReturnData } from "./contracts";

/**
 * Call a contract function (read-only, doesn't require transaction)
 * @param client Blockchain client
 * @param contractAddress Contract address
 * @param callData Function call data (encoded function selector + parameters)
 * @param from Optional caller address
 * @param value Optional ETH value to send
 * @returns Return data from contract execution
 */
export function callContract(
	client: BlockchainClientState,
	contractAddress: Address,
	callData: Uint8Array,
	from?: Address,
	value?: Wei,
): Uint8Array {
	return clientCall(client, contractAddress, callData, from, value);
}

/**
 * Send a transaction to a contract (state-changing, requires mining)
 * @param client Blockchain client
 * @param contractAddress Contract address
 * @param callData Function call data
 * @param from Sender address
 * @param privateKey Sender private key
 * @param value Optional ETH value to send
 * @param gasPrice Gas price (default: 1 gwei)
 * @param gasLimit Gas limit (default: 100000)
 * @returns Transaction hash
 */
export function sendContractTransaction(
	client: BlockchainClientState,
	contractAddress: Address,
	callData: Uint8Array,
	from: Address,
	privateKey: Uint8Array,
	value: Wei = 0n,
	gasPrice: bigint = 1000000000n,
	gasLimit: bigint = 100000n,
): string {
	// Get current nonce
	const account = getAccount(client.stateManager, from);

	const tx = createTransaction({
		type: "legacy",
		nonce: account.nonce,
		gasPrice,
		gasLimit,
		to: contractAddress,
		value,
		data: callData,
		chainId: client.config.chainId,
	});

	const signedTx = signTransaction(tx, privateKey);
	const success = clientSendTransaction(client, signedTx);

	if (!success) {
		throw new Error("Failed to send transaction");
	}

	// Return transaction hash
	const { txHash } = require("../utils");
	return txHash(signedTx);
}

/**
 * Read a uint256 value from a simple storage contract
 * @param client Blockchain client
 * @param contractAddress Contract address
 * @param from Optional caller address
 * @returns The stored value
 */
export function readStorageValue(
	client: BlockchainClientState,
	contractAddress: Address,
	from?: Address,
): bigint {
	const callData = createGetValueCallData();
	const returnData = callContract(client, contractAddress, callData, from);
	return decodeUint256ReturnData(returnData);
}

/**
 * Write a uint256 value to a simple storage contract
 * Note: This requires the contract to have a setter function
 * @param client Blockchain client
 * @param contractAddress Contract address
 * @param value Value to store
 * @param from Sender address
 * @param privateKey Sender private key
 * @param gasPrice Optional gas price
 * @param gasLimit Optional gas limit
 */
export function writeStorageValue(
	client: BlockchainClientState,
	contractAddress: Address,
	value: bigint,
	from: Address,
	privateKey: Uint8Array,
	gasPrice: bigint = 1000000000n,
	gasLimit: bigint = 100000n,
): void {
	// Convert value to 32-byte call data
	const valueHex = value.toString(16).padStart(64, "0");
	const callData = Uint8Array.from(Buffer.from(valueHex, "hex"));

	sendContractTransaction(
		client,
		contractAddress,
		callData,
		from,
		privateKey,
		0n,
		gasPrice,
		gasLimit,
	);
}
