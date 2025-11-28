import { assert, describe, it } from 'vitest'
import { Common, Hardfork, Mainnet } from '../../../../chain-config/index.ts'
import { KECCAK256_RLP } from '../../../../utils/index.ts'

import type { MerkleStateManager } from '../../../../state-manager/index.ts'
import { createVM } from '../../../index.ts'

describe('General MuirGlacier VM tests', () => {
  it('should accept muirGlacier hardfork option for supported chains', async () => {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.MuirGlacier })
    const vm = await createVM({ common })
    assert.isDefined(vm.stateManager)
    assert.deepEqual(
      (vm.stateManager as MerkleStateManager)['_trie'].root(),
      KECCAK256_RLP,
      'it has default trie',
    )
  })
})
