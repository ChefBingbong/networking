// import { genesisMPTStateRoot } from '@ethereumjs/mpt'
import { ChainGenesis } from '../chain-config/index.ts';

import type { Chain, Common, GenesisState } from '../chain-config/index.ts';

/**
 * Safe creation of a new Blockchain object awaiting the initialization function,
 * encouraged method to use when creating a blockchain object.
 *
 * @param opts Constructor options, see {@link BlockchainOptions}
 */

/**
 * Merkle genesis root
 * @param genesisState
 * @param common
 * @returns
 */
export async function genGenesisStateRoot(
  genesisState: GenesisState,
  common: Common,
): Promise<Uint8Array> {
  const genCommon = common.copy()
  genCommon.setHardforkBy({
    blockNumber: 0,
    timestamp: genCommon.genesis().timestamp,
  })
  // return genesisMPTStateRoo(genesisState)
  return new Uint8Array(0);
}

/**
 * Returns the genesis state root if chain is well known or an empty state's root otherwise
 */
export async function getGenesisStateRoot(chainId: Chain, common: Common): Promise<Uint8Array> {
  const chainGenesis = ChainGenesis[chainId]
  return chainGenesis !== undefined ? chainGenesis.stateRoot : genGenesisStateRoot({}, common)
}
