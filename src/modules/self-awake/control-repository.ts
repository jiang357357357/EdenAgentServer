import type { EdenDatabase } from '@eden/store'
import { currentAccount } from '../accounts/index.ts'

/** Each running realm/account has its own database; pausing preserves approved future plans. */
export class SelfAwakeControlRepository {
  constructor(private readonly database: EdenDatabase) {}

  /** Import the legacy installation preference once; persisted account control always wins. */
  initialize(initialEnabled: boolean | undefined, ownsScheduler = true): void {
    if (!ownsScheduler || initialEnabled === undefined) return
    this.assertAccount()
    this.database.transaction(() => {
      const result = this.database.connection.prepare(`INSERT INTO runtime_settings(key,value_json,updated_at)
        VALUES('self-awake.control',?,?) ON CONFLICT(key) DO NOTHING`).run(JSON.stringify(initialEnabled), Date.now())
      if (result.changes) this.database.connection.prepare('UPDATE self_awake_session_schedules SET revision=MAX(revision+1,?)').run(Date.now())
    })
  }

  read() {
    this.assertAccount()
    const row = this.database.connection.prepare("SELECT value_json,updated_at FROM runtime_settings WHERE key='self-awake.control'").get()
    if (!row) return { enabled: true, updatedAt: 0 }
    const enabled: unknown = JSON.parse(String(row.value_json))
    if (typeof enabled !== 'boolean') throw new Error('自醒开关状态损坏，请先修复配置')
    return { enabled, updatedAt: Number(row.updated_at) }
  }

  assertEnabled(): void {
    if (!this.read().enabled) throw new Error('自醒已关闭，请先在自醒页面开启')
  }

  update(enabled: boolean, expectedUpdatedAt: number) {
    return this.database.transaction(() => {
      const previous = this.read()
      if (previous.updatedAt !== expectedUpdatedAt) throw new Error('自醒开关已在其他页面修改，请刷新后重试')
      if (previous.enabled === enabled) return previous
      const now = Math.max(Date.now(), previous.updatedAt + 1)
      this.database.connection.prepare(`INSERT INTO runtime_settings(key,value_json,updated_at) VALUES('self-awake.control',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(enabled), now)
      // The same outbox revision orders pause/resume against timers saved before or after the switch.
      this.database.connection.prepare('UPDATE self_awake_session_schedules SET revision=MAX(revision+1,?)').run(now)
      return { enabled, updatedAt: now }
    })
  }

  private assertAccount(): void {
    const bound = this.database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value
    const account = currentAccount()
    if (account && bound !== account.key) throw new Error('自醒开关不属于当前账号运行实例')
  }
}
