import { createBlock } from '../../../block/index.ts'
import { Common, Hardfork, Mainnet } from '../../../chain-config/index.ts'
import { createAccessList2930Tx, createLegacyTx } from '../../../tx/index.ts'
import { assert, describe, it } from 'vitest'

import type { BlockData } from '../../../block/index.ts'
import type { AccessList2930TxData, TransactionType, TxData } from '../../../tx/index.ts'

describe('[Types]', () => {
  it('should ensure that the actual objects can be safely used as their data types', () => {
    // Dev note:
    // This test was written by @alcuadrado after discovering
    // issues in creating an object from its own data. It will
    // ensure that the classes can be initialized from their own data.

    type RequiredExceptOptionals<TypeT, OptionalFieldsT extends keyof TypeT> = Required<
      Omit<TypeT, OptionalFieldsT>
    > &
      Pick<TypeT, OptionalFieldsT>

    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Berlin })

    // Block
    const block = createBlock({}, { common }) as Omit<
      Required<BlockData>,
      'withdrawals' | 'executionWitness'
    >
    assert.isDefined(block, 'block')

    // Transactions
    type OptionalTxFields = 'to' | 'r' | 's' | 'v'

    // Legacy tx
    const legacyTx: RequiredExceptOptionals<
      TxData[typeof TransactionType.Legacy],
      OptionalTxFields
    > = createLegacyTx({}, { common })
    assert.isDefined(legacyTx, 'legacy tx')

    // Access List tx
    const accessListTx: RequiredExceptOptionals<AccessList2930TxData, OptionalTxFields> =
      createAccessList2930Tx({}, { common })
    assert.isDefined(accessListTx, 'accessList tx')
  })
})
