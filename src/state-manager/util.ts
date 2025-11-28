import { Account, bytesToHex } from '../utils'

import type { AccountFields, StateManagerInterface } from '../chain-config'
import type { Address } from '../utils'

export async function modifyAccountFields(
  stateManager: StateManagerInterface,
  address: Address,
  accountFields: AccountFields,
): Promise<void> {
  const account = (await stateManager.getAccount(address)) ?? new Account()

  account.nonce = accountFields.nonce ?? account.nonce
  account.balance = accountFields.balance ?? account.balance
  account.storageRoot = accountFields.storageRoot ?? account.storageRoot
  account.codeHash = accountFields.codeHash ?? account.codeHash
  account.codeSize = accountFields.codeSize ?? account.codeSize
  if (stateManager['_debug'] !== undefined) {
    for (const [field, value] of Object.entries(accountFields)) {
      stateManager['_debug'](
        `modifyAccountFields address=${address.toString()} ${field}=${value instanceof Uint8Array ? bytesToHex(value) : value} `,
      )
    }
  }
  await stateManager.putAccount(address, account)
}
