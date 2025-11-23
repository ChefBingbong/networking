// src/blockchain/tx/receipt.ts
import type {
	TransactionReceipt,
	Log,
	Hash,
	Address,
	BlockNumber,
} from "../types";

export function createReceipt(
	status: 0 | 1,
	cumulativeGasUsed: bigint,
	logsBloom: Uint8Array,
	logs: Log[],
	transactionHash: Hash,
	transactionIndex: number,
	blockHash: Hash,
	blockNumber: BlockNumber,
	from: Address,
	to?: Address,
	contractAddress?: Address,
	gasUsed?: bigint,
): TransactionReceipt {
	return {
		status,
		cumulativeGasUsed,
		logsBloom,
		logs,
		transactionHash,
		transactionIndex,
		blockHash,
		blockNumber,
		from,
		to,
		contractAddress,
		gasUsed: gasUsed ?? cumulativeGasUsed,
	};
}

