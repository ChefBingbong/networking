import { assert, describe, it } from 'vitest'
import { createBlockchain } from '../../../blockchain'
import { Chain } from '../../../chain-config'
import { getGenesis } from '../../../genesis'

import { createVM } from '../..'

describe('genesis', () => {
  it('should initialize with predefined genesis states', async () => {
    const f = async () => {
      const genesisState = getGenesis(Chain.Mainnet)

      const blockchain = await createBlockchain({ genesisState })
      await createVM({ blockchain })
    }

    assert.doesNotThrow(f, 'should allow for initialization with genesis from genesis package')
  })
})
