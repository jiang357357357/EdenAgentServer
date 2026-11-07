import { memoInfoSchema } from '@eden/api'
import type { JobInfo, JsonValue, MemoInfo } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { MemoRepository } from './repository.ts'
import type { MemoNotifications } from './notifications.ts'
import type { JobRepository } from '../jobs/index.ts'
import type { MemoChannelReceipt } from './channel.ts'

export interface PendingMemoDelivery {
  jobId: string; sessionId: string; requestId: string; memo: MemoInfo; target: JsonValue
  attempts: number; advanceMemo: boolean; historical: boolean
}

export class MemoDeliveryRepository {
  constructor(readonly database: EdenDatabase, private readonly memos: MemoRepository,
    private readonly notifications: MemoNotifications, private readonly jobs: JobRepository) {}

  enqueue(job: JobInfo, memo: MemoInfo, advanceMemo = true): boolean {
    if (!['memo.reminder', 'memo.reminder.redelivery'].includes(job.kind)) throw new Error('Only reminder jobs may enqueue a notification')
    if (!job.sessionId) throw new Error('提醒没有关联角色会话，尚未投递。')
    return this.database.transaction(() => {
      if (memo.relatedSessionId !== job.sessionId) throw new Error('Reminder target session mismatch')
      const now = Date.now()
      this.database.connection.prepare(`INSERT INTO memo_channel_deliveries
        (job_id,memo_id,session_id,request_id,memo_json,target_json,advance_memo,historical,state,retry_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(job.id, memo.id, job.sessionId, `memo-${job.id}`,
          JSON.stringify(memo), JSON.stringify(memo.delivery ?? { channel: 'auto' }), Number(advanceMemo),
          Number(job.kind === 'memo.reminder.redelivery'), now, now, now)
      this.notifications.recordInTransaction(job.id, memo)
      this.jobs.dispatchExternalInTransaction(job.id)
      return true
    })
  }

  recover(): void {
    this.database.transaction(() => {
      const db = this.database.connection, now = Date.now()
      // Old host sends cannot be replayed; a new role input has a durable identity.
      for (const row of db.prepare("SELECT job_id FROM memo_channel_deliveries WHERE state='sending' AND input_id IS NULL").all())
        this.jobs.settleExternalInTransaction(String(row.job_id), 'unknown', '旧发送过程中服务重启，结果未知；请先核对收件记录。')
      db.prepare("UPDATE memo_channel_deliveries SET state='unknown',error='旧发送结果未确认。',updated_at=? WHERE state='sending' AND input_id IS NULL").run(now)
      db.prepare("UPDATE memo_channel_deliveries SET state='queued',updated_at=? WHERE state='checking' AND input_id IS NULL").run(now)
      db.prepare("UPDATE memo_delivery_effects SET state='unknown',error='通信执行中服务重启，禁止自动重发。',updated_at=? WHERE state='running'").run(now)
    })
  }

  claim(now = Date.now()): PendingMemoDelivery | undefined {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare("SELECT * FROM memo_channel_deliveries WHERE state='queued' AND retry_at<=? ORDER BY created_at,job_id LIMIT 1").get(now)
      if (!row) return undefined
      this.database.connection.prepare("UPDATE memo_channel_deliveries SET state='checking',attempts=attempts+1,updated_at=? WHERE job_id=? AND state='queued'").run(now, row.job_id!)
      return fromRow({ ...row, attempts: Number(row.attempts) + 1 })
    })
  }

  awaiting(): { delivery: PendingMemoDelivery; state: string; turnId: string }[] {
    return this.database.connection.prepare(`SELECT d.*,i.state AS input_state,i.turn_id FROM memo_channel_deliveries d
      JOIN inputs i ON i.id=d.input_id WHERE d.state='checking'`).all()
      .map(row => ({ delivery: fromRow(row), state: String(row.input_state), turnId: String(row.turn_id) }))
  }

  attachInput(delivery: PendingMemoDelivery, inputId: string): void {
    if (!this.database.inTransaction) throw new Error('Role input must be attached in its admission transaction')
    const updated = this.database.connection.prepare("UPDATE memo_channel_deliveries SET input_id=?,updated_at=? WHERE job_id=? AND state='checking' AND input_id IS NULL")
      .run(inputId, Date.now(), delivery.jobId)
    if (updated.changes !== 1) throw new Error('Reminder decision was already admitted')
    this.database.connection.prepare("UPDATE jobs SET input_id=?,updated_at=? WHERE id=? AND state='dispatched'")
      .run(inputId, Date.now(), delivery.jobId)
    this.database.connection.prepare(`INSERT INTO qq_group_inputs
      SELECT i.id,i.session_id,i.turn_id,o.operator_qq,?,0,o.origin_json FROM inputs i JOIN qq_memo_origins o
      ON o.session_id=i.session_id AND o.memo_id=? WHERE i.id=?`).run(`memo:${delivery.jobId}`, delivery.memo.id, inputId)
  }

  current(delivery: PendingMemoDelivery): boolean {
    if (!delivery.advanceMemo) return true
    const current = this.memos.read(delivery.memo.id)
    return current.status === 'active' && current.updatedAt === delivery.memo.updatedAt
  }

  advancesOnReplay(jobId: string, memo: MemoInfo): boolean {
    const original = this.database.connection.prepare('SELECT advance_memo,state FROM memo_channel_deliveries WHERE job_id=?').get(jobId)
    const current = this.memos.read(memo.id)
    return Boolean(original?.advance_memo) && original?.state !== 'accepted'
      && current.status === 'active' && current.updatedAt === memo.updatedAt
  }

  reviewOutcome(jobId: string, decision: 'completed' | 'cancelled', note: string): void {
    if (!this.database.inTransaction) throw new Error('Reminder outcome review requires an owning transaction')
    const row = this.database.connection.prepare("SELECT * FROM memo_channel_deliveries WHERE job_id=? AND state='unknown'").get(jobId)
    if (!row) return
    this.database.connection.prepare("UPDATE memo_channel_deliveries SET state=?,receipt_json=?,error=?,updated_at=? WHERE job_id=? AND state='unknown'")
      .run(decision === 'completed' ? 'accepted' : 'cancelled', JSON.stringify({ confirmation: 'user_review', decision, note }),
        decision === 'completed' ? null : '用户停止投递；原发送结果仍未确认。', Date.now(), jobId)
    const delivery = fromRow(row)
    if (decision === 'completed' && delivery.advanceMemo && this.current(delivery))
      this.memos.deliveredInTransaction(delivery.memo.id, delivery.memo.updatedAt)
  }

  defer(delivery: PendingMemoDelivery, error: string): void {
    this.database.transaction(() => {
      const retryAt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(delivery.attempts, 8))
      this.database.connection.prepare("UPDATE memo_channel_deliveries SET state='queued',retry_at=?,error=?,updated_at=? WHERE job_id=? AND state='checking' AND input_id IS NULL")
        .run(retryAt, error.slice(0, 4000), Date.now(), delivery.jobId)
      this.jobs.externalProgressInTransaction(delivery.jobId, error)
    })
  }

  finish(delivery: PendingMemoDelivery, outcome: MemoChannelReceipt | { state: 'cancelled'; error: string }): void {
    this.database.transaction(() => {
      const updated = this.database.connection.prepare("UPDATE memo_channel_deliveries SET state=?,receipt_json=?,error=?,updated_at=? WHERE job_id=? AND state IN ('checking','sending')")
        .run(outcome.state, 'receipt' in outcome ? JSON.stringify(outcome.receipt ?? null) : null,
          outcome.error?.slice(0, 4000) ?? null, Date.now(), delivery.jobId)
      if (updated.changes !== 1) throw new Error('Reminder delivery was already settled')
      if (outcome.state === 'accepted' && delivery.advanceMemo && this.current(delivery))
        this.memos.deliveredInTransaction(delivery.memo.id, delivery.memo.updatedAt)
      this.jobs.settleExternalInTransaction(delivery.jobId, outcome.state === 'accepted' ? 'completed' : outcome.state, outcome.error ?? null)
    })
  }
}

function fromRow(row: Record<string, unknown>): PendingMemoDelivery {
  return { jobId: String(row.job_id), sessionId: String(row.session_id), requestId: String(row.request_id),
    memo: memoInfoSchema.parse(JSON.parse(String(row.memo_json))), target: JSON.parse(String(row.target_json)) as JsonValue,
    attempts: Number(row.attempts), advanceMemo: Boolean(row.advance_memo), historical: Boolean(row.historical) }
}
