import { assert, describe, it } from 'vitest'
import { createBlock, createBlockFromBytesArray, createBlockFromRLP } from '../../block'
import { Common, Hardfork, Mainnet } from '../../chain-config'
import * as RLP from '../../rlp'
import { MapDB, hexToBytes } from '../../utils'

import { Ethash } from '..'

import { blockTestsData } from './block_tests_data.ts'
import { invalidBlockRLP, validBlockRLP } from './ethash_block_rlp_tests.ts'

import type { BlockBytes } from '../../block'
import type { PrefixedHexString } from '../../utils'

const cacheDB = new MapDB()

describe('Verify POW for valid and invalid blocks', () => {
  it('should work', async () => {
    const e = new Ethash(cacheDB as any)

    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Istanbul })

    const genesis = createBlock({}, { common })
    const genesisResult = await e.verifyPOW(genesis)
    assert.isTrue(genesisResult, 'genesis block should be valid')

    const validRlp = hexToBytes(validBlockRLP)
    const validBlock = createBlockFromRLP(validRlp, { common })
    const validBlockResult = await e.verifyPOW(validBlock)
    assert.isTrue(validBlockResult, 'should be valid')

    const invalidRlp = hexToBytes(invalidBlockRLP)
    // Put correct amount of extraData in block extraData field so block can be deserialized
    const values = RLP.decode(Uint8Array.from(invalidRlp)) as BlockBytes
    values[0][12] = new Uint8Array(32)
    const invalidBlock = createBlockFromBytesArray(values, { common })
    const invalidBlockResult = await e.verifyPOW(invalidBlock)
    assert.isFalse(invalidBlockResult, 'should be invalid')

    const blockRlp = hexToBytes(blockTestsData.blocks[0].rlp as PrefixedHexString)
    const block = createBlockFromRLP(blockRlp, { common })
    const uncleBlockResult = await e.verifyPOW(block)
    assert.isTrue(uncleBlockResult, 'should be valid')
  })
})
