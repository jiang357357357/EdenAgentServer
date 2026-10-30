import { promptModeConfigSchema, promptModeUpdateSchema } from '@eden/api'
import { z } from 'zod'
import type { EdenDatabase } from '@eden/store'
import { currentAccount } from '../accounts/index.ts'
import { createPromptModeSnapshot, type PromptModeSnapshot } from '../../model-prompts/prompt-mode.ts'

// 兼容读取旧配置；手填正文不再返回客户端，也不参与新回合。
const storedModeSchema = z.object({ enabled: z.boolean(), template: z.string().max(65_536).optional() }).strict()

/** One configuration per authenticated account in this runtime realm. */
export class PromptModeRepository {
  constructor(private readonly database: EdenDatabase) {}

  private key(): string { return `prompt.mode:${JSON.stringify(currentAccount()?.key ?? 'local')}` }

  get() {
    const row = this.database.connection.prepare('SELECT value_json,updated_at FROM runtime_settings WHERE key=?').get(this.key())
    if (!row) return { enabled: false, updatedAt: 0 }
    try {
      const value = storedModeSchema.parse(JSON.parse(String(row.value_json)))
      return promptModeConfigSchema.parse({ enabled: value.enabled, updatedAt: Number(row.updated_at) })
    }
    catch { throw new Error('超限模式配置损坏，请检查当前世界的配置记录') }
  }

  update(input: unknown) {
    const { expectedUpdatedAt, ...value } = promptModeUpdateSchema.parse(input)
    return this.database.transaction(() => {
      const previous = this.get()
      if (previous.updatedAt !== expectedUpdatedAt) throw new Error('超限模式配置已变化，请重新读取后保存')
      const updatedAt = Math.max(Date.now(), previous.updatedAt + 1)
      this.database.connection.prepare(`INSERT INTO runtime_settings(key,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(this.key(), JSON.stringify(value), updatedAt)
      return { ...value, updatedAt }
    })
  }

  /** Freeze at admission, never copy an inactive template into a queued input. */
  snapshot(): PromptModeSnapshot { return createPromptModeSnapshot(this.get()) }
}
