import { z } from 'zod'
import { memoInfoSchema, memoIntegerSchema } from '@eden/api'
import type { JobInfo } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { JobRepository } from '../jobs/index.ts'
import type { SessionService } from '../sessions/index.ts'
import type { MemoRepository } from './repository.ts'
import type { MemoNotifications } from './notifications.ts'
import type { DatabaseSync } from 'node:sqlite'
import { MemoDeliveryRepository } from './delivery-repository.ts'
const payload = z.object({ memoId: memoIntegerSchema, revision: memoIntegerSchema, occurrence: memoIntegerSchema }).strict()

export class MemoJobRecovery {
  constructor(private readonly database: EdenDatabase, private readonly memos: MemoRepository,
    private readonly notifications: MemoNotifications, private readonly jobs: JobRepository, _sessions: SessionService,
    private readonly deliveries = new MemoDeliveryRepository(database, memos, notifications, jobs)) { }

  resolveOutcome(id: string, expectedUpdatedAt: number, decision: 'completed' | 'cancelled', note: string): JobInfo {
    return this.database.transaction(() => {
      const job = this.jobs.resolveOutcomeInTransaction(id, expectedUpdatedAt, decision, note)
      this.deliveries.reviewOutcome(id, decision, note)
      return job
    })
  }
  resubmit(jobId: string, expectedUpdatedAt: number, note: string): JobInfo {
    return this.database.transaction(() => {
      const db = this.database.connection
      const previous = db.prepare('SELECT * FROM memo_job_resubmissions WHERE source_job_id=?').get(jobId)
      if (previous) {
        if (previous.expected_updated_at !== expectedUpdatedAt || previous.note !== note) throw new Error('Reminder job was already resubmitted with different evidence')
        return this.jobs.read(String(previous.new_job_id))
      }
      const source = this.jobs.read(jobId)
      if (!['memo.reminder', 'memo.reminder.redelivery'].includes(source.kind) || !['failed', 'cancelled', 'completed'].includes(source.state) || source.updatedAt !== expectedUpdatedAt) throw new Error('Stop or review the original reminder job, then reload it')
      this.assertInputSettled(source)
      let delivered = this.recoverDeliverySnapshot(source, jobId, db)
      const next = this.jobs.scheduleInTransaction({
        kind: delivered ? 'memo.reminder.redelivery' : 'memo.reminder',
        sessionId: source.sessionId, dueAt: Date.now(), payload: delivered ? { sourceJobId: jobId } : source.payload,
        key: `memo-resubmit:${jobId}`, causationId: source.causationId, depth: source.depth
      })
      db.prepare('INSERT INTO memo_job_resubmissions VALUES(?,?,?,?,?,?,?)')
        .run(jobId, next.id, expectedUpdatedAt, delivered ? JSON.stringify(delivered) : null, note, Date.now(), delivered ? 'redelivery' : 'retry')
      return next
    })
  }

  private assertInputSettled(source: JobInfo): void {
    if (!source.inputId) return
    const db = this.database.connection
    const input = db.prepare('SELECT state,turn_id FROM inputs WHERE id=?').get(source.inputId)
    if (!input || !['cancelled', 'completed', 'failed', 'interrupted'].includes(String(input.state)))
      throw new Error('Explicitly stop the original reminder input before resubmitting')
    if (db.prepare(`SELECT 1 FROM tool_operations o WHERE o.turn_id=? AND o.state IN ('running','unknown')
      AND NOT EXISTS(SELECT 1 FROM memo_delivery_effects e JOIN job_outcome_reviews r ON r.job_id=e.job_id
        WHERE e.request_id=o.id AND e.job_id=? AND o.state='unknown') LIMIT 1`).get(input.turn_id!, source.id))
      throw new Error('Reconcile unknown reminder effects first')
  }
  private recoverDeliverySnapshot(source: JobInfo, jobId: string, db: DatabaseSync) {
    const original = source.kind === 'memo.reminder' ? payload.parse(source.payload) : undefined
    let delivered = this.notifications.forJob(jobId)
    if (!original) {
      const replay = z.object({ sourceJobId: z.string().uuid() }).strict().parse(source.payload)
      const basis = db.prepare("SELECT snapshot_json FROM memo_job_resubmissions WHERE source_job_id=? AND new_job_id=? AND mode='redelivery'").get(replay.sourceJobId, jobId)
      if (!basis) throw new Error('Previous reminder redelivery has no confirmed snapshot')
      const snapshot = memoInfoSchema.parse(JSON.parse(String(basis.snapshot_json)))
      if (delivered && JSON.stringify(delivered) !== JSON.stringify(snapshot)) throw new Error('Previous reminder notification differs from its confirmed snapshot')
      delivered = snapshot
    }
    if (!delivered) {
      const memo = this.memos.read(original!.memoId)
      if (memo.status !== 'active' || memo.updatedAt !== original!.revision || memo.lastTriggeredAt !== null && memo.lastTriggeredAt >= original!.occurrence) throw new Error('Reminder changed or advanced without a recoverable delivery snapshot; review the memo first')
    } else if (original && delivered.id !== original.memoId) throw new Error('Reminder snapshot ownership mismatch')
    return delivered
  }

  dispatch(job: JobInfo): void {
    const request = z.object({ sourceJobId: z.string().uuid() }).strict().parse(job.payload)
    const row = this.database.connection.prepare('SELECT snapshot_json FROM memo_job_resubmissions WHERE source_job_id=? AND new_job_id=? AND mode=\'redelivery\'').get(request.sourceJobId, job.id)
    if (!row) throw new Error('Reminder redelivery has no matching confirmation')
    const memo = memoInfoSchema.parse(JSON.parse(String(row.snapshot_json)))
    this.deliveries.enqueue(job, memo, this.deliveries.advancesOnReplay(request.sourceJobId, memo))
  }
}
