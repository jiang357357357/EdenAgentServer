import { z } from 'zod'
import { memoIntegerSchema } from '@eden/api'
import type { JobInfo } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { JobRepository } from '../jobs/index.ts'
import type { SessionService } from '../sessions/index.ts'
import type { MemoRepository } from './repository.ts'
import type { MemoNotifications } from './notifications.ts'
import { MemoDeliveryRepository } from './delivery-repository.ts'

const payloadSchema = z.object({ memoId: memoIntegerSchema, revision: memoIntegerSchema, occurrence: memoIntegerSchema }).strict()

export function memoDispatcher(database: EdenDatabase, memos: MemoRepository, notifications: MemoNotifications,
  jobs: JobRepository, _sessions: SessionService, deliveries = new MemoDeliveryRepository(database, memos, notifications, jobs)) {
  return (job: JobInfo): void => {
    const payload = payloadSchema.parse(job.payload)
    const memo = memos.read(payload.memoId)
    if (memo.status !== 'active' || memo.updatedAt !== payload.revision || (memo.lastTriggeredAt !== null && memo.lastTriggeredAt >= payload.occurrence)) {
      database.transaction(() => jobs.completeInTransaction(job.id))
      return
    }
    deliveries.enqueue(job, memo)
  }
}
