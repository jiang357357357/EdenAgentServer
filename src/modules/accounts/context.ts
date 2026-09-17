import { AsyncLocalStorage } from 'node:async_hooks'
import type { EdenDatabase } from '@eden/store'

export interface Account { key: string; userId: string; coreBaseUrl: string }
const context = new AsyncLocalStorage<Account>()
const registered = new WeakSet<EdenDatabase>()
export function withoutAccount<T>(action: () => T): T { return context.exit(action) }
export function currentAccount() { return context.getStore() }
export function withAccount<T>(account: Account | undefined, action: () => T): T {
  return account ? context.run(account, action) : action()
}
/** Internal scheduler work has no browser principal; remote entry points must authenticate first. */
export function accountFilter(database: EdenDatabase, column: string): string {
  if (!registered.has(database)) {
    database.connection.function('eden_account', () => currentAccount()?.key ?? null)
    registered.add(database)
  }
  return `(eden_account() IS NULL OR ${column} IN (SELECT session_id FROM session_owners WHERE account_key=eden_account()))`
}
export function accountKey(base: string, userId: string): string {
  return JSON.stringify([new URL(base.replace(/\/+$/, '') + '/').href, userId])
}
