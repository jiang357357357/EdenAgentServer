import type { EdenDatabase } from '@eden/store'
import { currentAccount, type Account } from './context.ts'

export class SessionOwnership {
  constructor(private readonly database: EdenDatabase) {}
  owner(sessionId: string): string | undefined {
    const row = this.database.connection.prepare('SELECT account_key FROM session_owners WHERE session_id=?').get(sessionId)
    return row ? String(row.account_key) : undefined
  }
  assign(sessionId: string, key: string): void {
    const previous = this.owner(sessionId)
    if (previous && previous !== key) throw new Error('会话账号归属冲突')
    this.database.connection.prepare('INSERT OR IGNORE INTO session_owners(session_id,account_key) VALUES(?,?)').run(sessionId, key)
  }
  account(sessionId: string): Account | undefined {
    const key = this.owner(sessionId)
    if (!key) return undefined
    const [coreBaseUrl, userId] = JSON.parse(key) as [string, string]
    return { key, coreBaseUrl, userId }
  }
  visible(sessionId: string, key = currentAccount()?.key): boolean {
    return key === undefined || this.owner(sessionId) === key
  }
  assert(sessionId: string): void {
    if (!this.visible(sessionId)) throw new Error('会话不存在或不属于当前账号')
  }
}
