// src/blockchain/consensus/clique/types.ts
import type { Address, BlockHeader } from "../../types";

// Magic nonce number to vote on adding a new signer
export const CLIQUE_NONCE_AUTH = new Uint8Array(
	[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
);

// Magic nonce number to vote on removing a signer
export const CLIQUE_NONCE_DROP = new Uint8Array(8);

// Block difficulty for in-turn signatures
export const CLIQUE_DIFF_INTURN = 2n;

// Block difficulty for out-of-turn signatures
export const CLIQUE_DIFF_NOTURN = 1n;

// Clique Signer State
export type CliqueSignerState = [blockNumber: bigint, signers: Address[]];
export type CliqueLatestSignerStates = CliqueSignerState[];

// Clique Vote
export type CliqueVote = [
	blockNumber: bigint,
	vote: [signer: Address, beneficiary: Address, cliqueNonce: Uint8Array],
];
export type CliqueLatestVotes = CliqueVote[];

// Clique Block Signer
export type CliqueBlockSigner = [blockNumber: bigint, signer: Address];
export type CliqueLatestBlockSigners = CliqueBlockSigner[];

export interface CliqueConfig {
	epoch: number; // Number of blocks between epoch transitions
	period: number; // Minimum time between blocks (seconds)
}

