import { rpcMethods, type JsonValue } from '@eden/api'
import type { JobRepository } from '../../modules/jobs/index.ts'
import type { MemoJobRecovery } from '../../modules/memos/index.ts'
import { contractHandler } from './contract-handler.ts'
export function jobRoutes(jobs: JobRepository, reminders?: Pick<MemoJobRecovery, 'resolveOutcome'>): Record<string, (params: JsonValue) => Promise<JsonValue>> {
  return {
    'job.list': contractHandler(rpcMethods['job.list'], input => jobs.list(input)),
    'job.page': contractHandler(rpcMethods['job.page'], input => jobs.page(input)),
    'job.read': contractHandler(rpcMethods['job.read'], input => jobs.read(input.id)),
    'job.cancel': contractHandler(rpcMethods['job.cancel'], input => jobs.cancel(input.id)),
    'job.resolve': contractHandler(rpcMethods['job.resolve'], input => {
      const owner = reminders && ['memo.reminder', 'memo.reminder.redelivery'].includes(jobs.read(input.id).kind) ? reminders : jobs
      return owner.resolveOutcome(input.id, input.expectedUpdatedAt, input.decision, input.note)
    }),
  }
}
