// src/blockchain/consensus/clique.ts
import type { Database } from "../../db/database";
import type { Address, Block, BlockHeader } from "../../types";
import {
	bigIntToBytes,
	bytesToBigInt,
	rlpDecode,
	rlpEncode,
} from "../../utils";
import {
	CLIQUE_DIFF_INTURN,
	CLIQUE_DIFF_NOTURN,
	CLIQUE_NONCE_AUTH,
	CLIQUE_NONCE_DROP,
	type CliqueBlockSigner,
	type CliqueConfig,
	type CliqueLatestBlockSigners,
	type CliqueLatestSignerStates,
	type CliqueLatestVotes,
	type CliqueVote,
} from "./types";
import {
	cliqueEpochTransitionSigners,
	cliqueIsEpochTransition,
	cliqueSigner,
	cliqueVerifySignature,
} from "./utils";

const CLIQUE_SIGNERS_KEY = "CliqueSigners";
const CLIQUE_VOTES_KEY = "CliqueVotes";
const CLIQUE_BLOCK_SIGNERS_SNAPSHOT_KEY = "CliqueBlockSignersSnapshot";

/**
 * Keep signer history data (signer states and votes)
 * for all block numbers >= HEAD_BLOCK - CLIQUE_SIGNER_HISTORY_BLOCK_LIMIT
 *
 * This defines a limit for reorgs on PoA clique chains.
 */
const CLIQUE_SIGNER_HISTORY_BLOCK_LIMIT = 200;

export interface CliqueConsensusState {
	db: Database;
	config: CliqueConfig;
	_cliqueLatestSignerStates: CliqueLatestSignerStates;
	_cliqueLatestVotes: CliqueLatestVotes;
	_cliqueLatestBlockSigners: CliqueLatestBlockSigners;
}

export function createCliqueConsensus(
	db: Database,
	config: CliqueConfig,
): CliqueConsensusState {
	return {
		db,
		config,
		_cliqueLatestSignerStates: [],
		_cliqueLatestVotes: [],
		_cliqueLatestBlockSigners: [],
	};
}

export async function setupCliqueConsensus(
	consensus: CliqueConsensusState,
): Promise<void> {
	consensus._cliqueLatestSignerStates = await getCliqueLatestSignerStates(
		consensus.db,
	);
	consensus._cliqueLatestSignerStates.sort((a, b) => (a[0] > b[0] ? 1 : -1));
	consensus._cliqueLatestVotes = await getCliqueLatestVotes(consensus.db);
	consensus._cliqueLatestBlockSigners = await getCliqueLatestBlockSigners(
		consensus.db,
	);
}

export async function cliqueGenesisInit(
	consensus: CliqueConsensusState,
	genesisBlock: Block,
): Promise<void> {
	await cliqueSaveGenesisSigners(consensus, genesisBlock);
}

export async function validateCliqueConsensus(
	consensus: CliqueConsensusState,
	block: Block,
): Promise<void> {
	const { header } = block;
	const valid = cliqueVerifySignature(
		header,
		cliqueActiveSigners(consensus, header.number),
	);
	if (!valid) {
		throw new Error("invalid PoA block signature (clique)");
	}
	if (cliqueCheckRecentlySigned(consensus, header)) {
		throw new Error("recently signed");
	}

	// validate checkpoint signers towards active signers on epoch transition blocks
	if (cliqueIsEpochTransition(header, consensus.config.epoch)) {
		const checkpointSigners = cliqueEpochTransitionSigners(
			header,
			consensus.config.epoch,
		);
		const activeSigners = cliqueActiveSigners(consensus, header.number);
		for (const [i, cSigner] of checkpointSigners.entries()) {
			if (activeSigners[i]?.toLowerCase() !== cSigner.toLowerCase()) {
				throw new Error(
					`checkpoint signer not found in active signers list at index ${i}: ${cSigner}`,
				);
			}
		}
	}
}

export async function validateCliqueDifficulty(
	consensus: CliqueConsensusState,
	header: BlockHeader,
): Promise<void> {
	if (
		header.difficulty !== CLIQUE_DIFF_INTURN &&
		header.difficulty !== CLIQUE_DIFF_NOTURN
	) {
		throw new Error(
			`difficulty for clique block must be INTURN (2) or NOTURN (1), received: ${header.difficulty}`,
		);
	}

	const signers = cliqueActiveSigners(consensus, header.number);
	if (signers.length === 0) {
		throw new Error("no signers available");
	}
	const signerIndex = signers.findIndex(
		(address: Address) =>
			address.toLowerCase() === cliqueSigner(header).toLowerCase(),
	);
	const inTurn = header.number % BigInt(signers.length) === BigInt(signerIndex);
	if (
		(inTurn && header.difficulty !== CLIQUE_DIFF_INTURN) ||
		(!inTurn && header.difficulty !== CLIQUE_DIFF_NOTURN)
	) {
		throw new Error(
			`difficulty mismatch: expected ${inTurn ? CLIQUE_DIFF_INTURN : CLIQUE_DIFF_NOTURN}, got ${header.difficulty}`,
		);
	}
}

/**
 * Returns a list with the current block signers
 */
export function cliqueActiveSigners(
	consensus: CliqueConsensusState,
	blockNum: bigint,
): Address[] {
	const signers = consensus._cliqueLatestSignerStates;
	if (signers.length === 0) {
		return [];
	}
	for (let i = signers.length - 1; i >= 0; i--) {
		if (signers[i]![0] <= blockNum) {
			return signers[i]![1];
		}
	}
	throw new Error(`Could not load signers for block ${blockNum}`);
}

/**
 * Number of consecutive blocks out of which a signer may only sign one.
 */
function cliqueSignerLimit(
	consensus: CliqueConsensusState,
	blockNum: bigint,
): number {
	return Math.floor(cliqueActiveSigners(consensus, blockNum).length / 2) + 1;
}

/**
 * Checks if signer was recently signed.
 */
function cliqueCheckRecentlySigned(
	consensus: CliqueConsensusState,
	header: BlockHeader,
): boolean {
	if (header.number === 0n || header.number === 1n) {
		return false;
	}
	const limit = cliqueSignerLimit(consensus, header.number);
	let signers = consensus._cliqueLatestBlockSigners;
	signers = signers.slice(signers.length < limit ? 0 : 1);
	if (
		signers.length > 0 &&
		signers[signers.length - 1]![0] !== header.number - 1n
	) {
		return false;
	}
	signers.push([header.number, cliqueSigner(header)]);
	const seen = signers.filter(
		(s) => s[1].toLowerCase() === cliqueSigner(header).toLowerCase(),
	).length;
	return seen > 1;
}

/**
 * Save genesis signers from extraData
 */
async function cliqueSaveGenesisSigners(
	consensus: CliqueConsensusState,
	genesisBlock: Block,
): Promise<void> {
	const signers = cliqueEpochTransitionSigners(
		genesisBlock.header,
		consensus.config.epoch,
	);
	if (signers.length > 0) {
		consensus._cliqueLatestSignerStates.push([0n, signers]);
		await cliqueUpdateSignerStates(consensus);
	}
}

/**
 * Update snapshot of latest clique signer states.
 */
async function cliqueUpdateSignerStates(
	consensus: CliqueConsensusState,
): Promise<void> {
	const formatted = consensus._cliqueLatestSignerStates.map((state) => [
		bigIntToBytes(state[0]),
		state[1].map((addr) => {
			const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
			return Uint8Array.from(Buffer.from(clean, "hex"));
		}),
	]);

	const encoded = rlpEncode(formatted);
	console.log(
		`Saving ${formatted.length} signer states, encoded length: ${encoded.length} bytes`,
	);

	await consensus.db.put(CLIQUE_SIGNERS_KEY, encoded);
}

/**
 * Update snapshot of latest clique votes.
 */
async function cliqueUpdateVotes(
	consensus: CliqueConsensusState,
	header?: BlockHeader,
): Promise<void> {
	if (header) {
		const signer = cliqueSigner(header);
		const beneficiary = header.beneficiary;
		const nonce =
			header.nonce === CLIQUE_DIFF_INTURN
				? CLIQUE_NONCE_AUTH
				: CLIQUE_NONCE_DROP;

		// Check if this is a vote
		if (nonce === CLIQUE_NONCE_AUTH || nonce === CLIQUE_NONCE_DROP) {
			const vote: CliqueVote = [header.number, [signer, beneficiary, nonce]];
			consensus._cliqueLatestVotes.push(vote);
		}
	}

	// Trim votes based on history limit
	const limit = CLIQUE_SIGNER_HISTORY_BLOCK_LIMIT;
	const blockSigners = consensus._cliqueLatestBlockSigners;
	const lastBlockNumber = blockSigners[blockSigners.length - 1]?.[0];
	if (lastBlockNumber) {
		const lastEpochBlockNumber =
			lastBlockNumber - (lastBlockNumber % BigInt(consensus.config.epoch));
		const blockLimit = lastEpochBlockNumber - BigInt(limit);
		consensus._cliqueLatestVotes = consensus._cliqueLatestVotes.filter(
			(state) => state[0] >= blockLimit,
		);
	}

	// save votes to db
	const formatted = consensus._cliqueLatestVotes.map((v) => [
		bigIntToBytes(v[0]),
		[
			Uint8Array.from(Buffer.from(v[1][0].slice(2), "hex")),
			Uint8Array.from(Buffer.from(v[1][1].slice(2), "hex")),
			v[1][2],
		],
	]);
	await consensus.db.put(CLIQUE_VOTES_KEY, rlpEncode(formatted));
}

/**
 * Update snapshot of latest clique block signers.
 */
async function cliqueUpdateLatestBlockSigners(
	consensus: CliqueConsensusState,
	header?: BlockHeader,
): Promise<void> {
	if (header) {
		if (header.number === 0n) {
			return;
		}
		const signer: CliqueBlockSigner = [header.number, cliqueSigner(header)];
		consensus._cliqueLatestBlockSigners.push(signer);

		const length = consensus._cliqueLatestBlockSigners.length;
		const limit = cliqueSignerLimit(consensus, header.number);
		if (length > limit) {
			consensus._cliqueLatestBlockSigners =
				consensus._cliqueLatestBlockSigners.slice(length - limit, length);
		}
	}

	const formatted = consensus._cliqueLatestBlockSigners.map((b) => [
		bigIntToBytes(b[0]),
		Uint8Array.from(Buffer.from(b[1].slice(2), "hex")),
	]);
	await consensus.db.put(
		CLIQUE_BLOCK_SIGNERS_SNAPSHOT_KEY,
		rlpEncode(formatted),
	);
}

/**
 * Build clique snapshots.
 */
export async function cliqueBuildSnapshots(
	consensus: CliqueConsensusState,
	header: BlockHeader,
): Promise<void> {
	if (!cliqueIsEpochTransition(header, consensus.config.epoch)) {
		await cliqueUpdateVotes(consensus, header);
	}
	await cliqueUpdateLatestBlockSigners(consensus, header);
}

/**
 * Fetches clique signers.
 */
async function getCliqueLatestSignerStates(
	db: Database,
): Promise<CliqueLatestSignerStates> {
	const signerStates = await db.get(CLIQUE_SIGNERS_KEY);
	if (signerStates === undefined) {
		console.log("No signer states found in DB");
		return [];
	}

	console.log(`Retrieved signer states from DB: ${signerStates.length} bytes`);
	if (signerStates.length < 10) {
		console.error(
			`Warning: Signer states data is suspiciously small (${signerStates.length} bytes). Clearing corrupted data.`,
		);
		await db.del(CLIQUE_SIGNERS_KEY);
		return [];
	}

	try {
		const decoded = rlpDecode(signerStates);

		// Debug: Log the decoded structure
		console.log(
			"Decoded signer states type:",
			typeof decoded,
			Array.isArray(decoded),
		);
		if (Array.isArray(decoded)) {
			console.log("Decoded array length:", decoded.length);
			if (decoded.length > 0) {
				console.log(
					"First item type:",
					typeof decoded[0],
					Array.isArray(decoded[0]),
				);
			}
		}

		if (!Array.isArray(decoded)) {
			console.error("Decoded data is not an array:", typeof decoded);
			return [];
		}

		const states: CliqueLatestSignerStates = [];
		for (const state of decoded) {
			if (!Array.isArray(state) || state.length < 2) {
				console.error("Invalid state format:", state);
				continue;
			}

			// First element should be block number bytes
			const blockNumBytes = state[0];
			if (!(blockNumBytes instanceof Uint8Array)) {
				console.error("Block number is not Uint8Array:", blockNumBytes);
				continue;
			}
			const blockNum = bytesToBigInt(blockNumBytes);

			// Second element should be array of address bytes
			const addressesData = state[1];
			if (!Array.isArray(addressesData)) {
				console.error("Addresses data is not an array:", addressesData);
				continue;
			}

			const addresses: Address[] = [];
			for (const addrBytes of addressesData) {
				if (!(addrBytes instanceof Uint8Array)) {
					console.error("Address bytes is not Uint8Array:", addrBytes);
					continue;
				}
				addresses.push(
					`0x${Buffer.from(addrBytes).toString("hex")}` as Address,
				);
			}

			states.push([blockNum, addresses]);
		}

		return states;
	} catch (error) {
		console.error("Error decoding signer states:", error);
		return [];
	}
}

/**
 * Fetches clique votes.
 */
async function getCliqueLatestVotes(db: Database): Promise<CliqueLatestVotes> {
	const signerVotes = await db.get(CLIQUE_VOTES_KEY);
	if (signerVotes === undefined) return [];
	const votes = rlpDecode(signerVotes) as [
		Uint8Array,
		[Uint8Array, Uint8Array, Uint8Array],
	][];
	return votes.map((vote) => {
		const blockNum = bytesToBigInt(vote[0]!);
		const signer = `0x${Buffer.from(vote[1][0]!).toString("hex")}` as Address;
		const beneficiary =
			`0x${Buffer.from(vote[1][1]!).toString("hex")}` as Address;
		const nonce = vote[1][2]!;
		return [blockNum, [signer, beneficiary, nonce]];
	}) as CliqueLatestVotes;
}

/**
 * Fetches snapshot of clique signers.
 */
async function getCliqueLatestBlockSigners(
	db: Database,
): Promise<CliqueLatestBlockSigners> {
	const blockSigners = await db.get(CLIQUE_BLOCK_SIGNERS_SNAPSHOT_KEY);
	if (blockSigners === undefined) return [];
	const signers = rlpDecode(blockSigners) as [Uint8Array, Uint8Array][];
	return signers.map((s) => {
		const blockNum = bytesToBigInt(s[0]!);
		const signer = `0x${Buffer.from(s[1]!).toString("hex")}` as Address;
		return [blockNum, signer];
	}) as CliqueLatestBlockSigners;
}

/**
 * Helper to determine if a signer is in or out of turn for the next block.
 */
export async function cliqueSignerInTurn(
	consensus: CliqueConsensusState,
	signer: Address,
	blockNum: bigint,
): Promise<boolean> {
	const signers = cliqueActiveSigners(consensus, blockNum);
	const signerIndex = signers.findIndex(
		(address) => address.toLowerCase() === signer.toLowerCase(),
	);
	if (signerIndex === -1) {
		throw new Error("Signer not found");
	}
	return (blockNum + 1n) % BigInt(signers.length) === BigInt(signerIndex);
}
