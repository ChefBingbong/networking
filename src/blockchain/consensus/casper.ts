import type { BlockHeader } from "../../block/index.ts";
import { ConsensusAlgorithm } from "../../chain-config/enums.ts";
import { BIGINT_0 } from "../../utils/index.ts";
import type { Consensus } from "../types.ts";

/**
 * This class encapsulates Casper-related consensus functionality when used with the Blockchain class.
 */
export class CasperConsensus implements Consensus {
	algorithm: ConsensusAlgorithm;

	constructor() {
		this.algorithm = ConsensusAlgorithm.Casper;
	}

	public async genesisInit(): Promise<void> {}

	public async setup(): Promise<void> {}

	public async validateConsensus(): Promise<void> {}

	public async validateDifficulty(header: BlockHeader): Promise<void> {
		// TODO: This is not really part of consensus validation and it should be analyzed
		// if it is possible to replace by a more generic hardfork check between block and
		// blockchain along adding new blocks or headers
		if (header.difficulty !== BIGINT_0) {
			const msg = "invalid difficulty.  PoS blocks must have difficulty 0";
			throw Error(`${msg} ${header.errorStr()}`);
		}
	}
	public async newBlock(): Promise<void> {}
}
