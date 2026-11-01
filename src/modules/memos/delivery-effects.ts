import { memoInfoSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { MemoChannelReceipt } from './channel.ts'
import type { MemoDeliveryRepository } from './delivery-repository.ts'
import { communicationChannel, communicationReceipt, record } from './communication-receipt.ts'
import type { CommunicationReceipt } from './communication-receipt.ts'

/** Receipts come from host tool implementations, never from role-authored claims. */
export class MemoDeliveryEffects {
  constructor(private readonly repository: MemoDeliveryRepository,
    private readonly deviceStatus?: (sessionId: string, id: string, signal: AbortSignal) => Promise<JsonValue>) {}

  wrap(tool: RuntimeTool, sessionId: string, turnId: string): RuntimeTool {
    if (tool.source && tool.source !== 'builtin') return tool
    return { ...tool, execute: async (input, context) => {
      const channel = communicationChannel(tool.name, input)
      if (!channel) return tool.execute(input, context)
      const db = this.repository.database.connection
      const row = db.prepare(`SELECT d.* FROM memo_channel_deliveries d JOIN inputs i ON i.id=d.input_id
        WHERE i.session_id=? AND i.turn_id=?`).get(sessionId, turnId)
      if (!row) return tool.execute(input, context)
      this.begin(row, channel, `${turnId}:${context.callId}`)
      try {
        const result = await tool.execute(input, { ...context, assertCurrent: () => {
          context.assertCurrent?.()
          const memo = memoInfoSchema.parse(JSON.parse(String(row.memo_json)))
          if (!this.repository.current({ jobId: String(row.job_id), sessionId, requestId: '', memo,
            target: memo.delivery ?? { channel: 'auto' }, attempts: 0, advanceMemo: Boolean(row.advance_memo), historical: Boolean(row.historical) }))
            throw Object.assign(new Error('提醒在审批期间已修改或取消，尚未发送。'), { toolOutcome: 'failed' })
        } })
        this.save(`${turnId}:${context.callId}`, communicationReceipt(channel, result))
        return result
      } catch (error) {
        const contact = ['send_qq_message', 'send_external_email'].includes(tool.name)
        const receipt = db.prepare('SELECT state,receipt_json FROM mon_contact_deliveries WHERE request_id=? AND session_id=?')
          .get(`${turnId}:${context.callId}`, sessionId)
        const notSent = ['failed', 'cancelled'].includes(String(record(error).toolOutcome))
        const state = notSent || contact && (!receipt || receipt.state === 'failed') ? 'failed' : 'unknown'
        this.save(`${turnId}:${context.callId}`, receipt?.state === 'accepted'
          ? { state: 'accepted', receipt: { channel, requestId: `${turnId}:${context.callId}` } }
          : { state, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    } }
  }

  private begin(row: Record<string, unknown>, channel: string, requestId: string): void {
    this.repository.database.transaction(() => {
      const db = this.repository.database.connection
      if (row.state !== 'checking') throw new Error('提醒已结算，不能继续发送。')
      const memo = memoInfoSchema.parse(JSON.parse(String(row.memo_json)))
      if (!this.repository.current({ jobId: String(row.job_id), sessionId: String(row.session_id), requestId,
        memo, target: memo.delivery ?? { channel: 'auto' }, attempts: 0, advanceMemo: Boolean(row.advance_memo), historical: Boolean(row.historical) }))
        throw new Error('提醒已修改或取消，禁止发送旧内容。')
      const policy = record(JSON.parse(String(row.target_json)))
      if (policy.channel !== 'auto' && policy.channel !== channel) throw new Error(`用户指定了 ${String(policy.channel)} 渠道，请遵守该选择。`)
      if (db.prepare("SELECT 1 FROM memo_delivery_effects WHERE job_id=? AND state IN ('running','pending','accepted','unknown') LIMIT 1").get(row.job_id as string))
        throw new Error('此提醒已有成功、进行中或结果未知的通信，请核对原记录，不能重复发送。')
      db.prepare("INSERT INTO memo_delivery_effects VALUES(?,?,?,'running',NULL,NULL,?,?)")
        .run(requestId, row.job_id as string, channel, Date.now(), Date.now())
    })
  }

  private save(requestId: string, receipt: CommunicationReceipt): void {
    this.repository.database.connection.prepare('UPDATE memo_delivery_effects SET state=?,receipt_json=?,error=?,updated_at=? WHERE request_id=?')
      .run(receipt.state, JSON.stringify(receipt.receipt ?? null), receipt.error?.slice(0, 4000) ?? null, Date.now(), requestId)
  }

  async outcome(jobId: string, signal: AbortSignal): Promise<MemoChannelReceipt | { state: 'pending' } | undefined> {
    const db = this.repository.database.connection
    const pending = db.prepare("SELECT e.*,d.session_id FROM memo_delivery_effects e JOIN memo_channel_deliveries d ON d.job_id=e.job_id WHERE e.job_id=? AND e.state='pending'").all(jobId)
    for (const effect of pending) await this.refreshPending(effect, signal)
    const effects = db.prepare('SELECT state,receipt_json,error FROM memo_delivery_effects WHERE job_id=? ORDER BY created_at,request_id').all(jobId)
    const accepted = effects.find(effect => effect.state === 'accepted')
    if (accepted) return { state: 'accepted', receipt: JSON.parse(String(accepted.receipt_json)) as JsonValue }
    if (effects.some(effect => ['running', 'unknown'].includes(String(effect.state))))
      return { state: 'unknown', error: '通信结果未知，请核对收件记录；不会自动重发。' }
    if (effects.some(effect => effect.state === 'pending')) return { state: 'pending' }
    if (effects.length) return { state: 'failed', error: String(effects.at(-1)!.error ?? '通信渠道未确认发送。') }
    return undefined
  }

  private async refreshPending(effect: Record<string, import('node:sqlite').SQLOutputValue>, signal: AbortSignal): Promise<void> {
    const db = this.repository.database.connection
    const receipt = record(JSON.parse(String(effect.receipt_json)))
    if (effect.channel === 'app') {
      const reminder = db.prepare('SELECT displayed_at,state FROM desktop_reminders WHERE id=? AND session_id=?').get(String(receipt.id), effect.session_id!)
      if (reminder?.displayed_at != null) this.save(String(effect.request_id), { state: 'accepted', receipt: { id: String(receipt.id), displayed: true } })
      else if (!reminder || reminder.state === 'closed') this.save(String(effect.request_id), { state: 'failed', error: '桌面提醒未显示即被关闭或移除。' })
    } else if (effect.channel === 'device' && this.deviceStatus) {
      try {
        const status = record(await this.deviceStatus(String(effect.session_id), String(receipt.id), AbortSignal.any([signal, AbortSignal.timeout(5000)])))
        if (status.id !== receipt.id) return
        if (status.status === 'succeeded') this.save(String(effect.request_id), { state: 'accepted', receipt: { id: String(receipt.id), status: 'succeeded' } })
        else if (['failed', 'expired', 'cancelled'].includes(String(status.status)))
          this.save(String(effect.request_id), { state: 'failed', error: '设备未完成通知命令。' })
      } catch { /* A status read is safe to retry; the original command is never resent. */ }
    }
  }
}
