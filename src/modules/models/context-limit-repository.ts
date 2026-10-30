import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { EdenDatabase } from '@eden/store'
import type { RuntimeModel } from '@eden/runtime-pi'

const settingSchema = z.object({ limit: z.number().int().positive().nullable(), revision: z.uuid() }).strict()
const reserve = (limit: number) => Math.max(512, Math.ceil(limit * 0.05))
const minimum = (model: RuntimeModel) => Math.min(model.contextWindow,
  Math.max(8192, model.maxTokens + 4096, Math.ceil((model.maxTokens + 512) / 0.95)))

/** A conversation's input budget, independent of provider credentials and Core bindings. */
export class ModelContextLimitRepository {
  constructor(private readonly database: EdenDatabase) {}

  private setting(sessionId: string) {
    const row = this.database.connection.prepare('SELECT value_json FROM runtime_settings WHERE key=?').get(`model-context:${sessionId}`)
    return row ? settingSchema.parse(JSON.parse(String(row.value_json))) : null
  }

  apply(sessionId: string, model: RuntimeModel | undefined): RuntimeModel | undefined {
    if (!model) return undefined
    const limit = this.setting(sessionId)?.limit
    return limit == null ? model : { ...model, contextWindow: Math.min(model.contextWindow, Math.max(minimum(model), limit)) }
  }

  read(sessionId: string, models: RuntimeModel[]) {
    if (models.length === 0) throw new Error('请先为当前会话配置模型。')
    const setting = this.setting(sessionId)
    const modelKey = createHash('sha256').update(JSON.stringify(models.map(model =>
      [model.provider, model.id, model.baseUrl, model.contextWindow, model.maxTokens]))).digest('hex')
    const defaultContextWindow = Math.min(...models.map(model => model.contextWindow))
    const minContextWindow = Math.min(defaultContextWindow, Math.max(...models.map(minimum)))
    const applied = models.map(model => this.apply(sessionId, model)!)
    return {
      contextWindow: Math.min(...applied.map(model => model.contextWindow)), defaultContextWindow, minContextWindow,
      maxOutputTokens: Math.max(...models.map(model => model.maxTokens)),
      inputBudget: Math.max(0, Math.min(...applied.map(model => model.contextWindow - model.maxTokens - reserve(model.contextWindow)))),
      override: setting?.limit ?? null, modelKey, revision: setting?.revision ?? null,
    }
  }

  set(sessionId: string, models: RuntimeModel[], limit: number | null, expectedModelKey: string, expectedRevision: string | null) {
    return this.database.transaction(() => {
      const current = this.read(sessionId, models)
      if (current.modelKey !== expectedModelKey || current.revision !== expectedRevision) throw new Error('模型或上下文设置已变化，请重新打开窗口后保存。')
      if (limit !== null && (!Number.isSafeInteger(limit) || limit < current.minContextWindow || limit > current.defaultContextWindow)) {
        throw new Error(`上下文上限须为 ${current.minContextWindow} 至 ${current.defaultContextWindow} 之间的整数。`)
      }
      this.database.connection.prepare(`INSERT INTO runtime_settings(key,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
        .run(`model-context:${sessionId}`, JSON.stringify({ limit, revision: randomUUID() }), Date.now())
      return this.read(sessionId, models)
    })
  }
}
