import { toJson } from '@eden/api'
import type { JobInfo, JsonValue } from '@eden/api'

/** Model-readable receipt reflects the persisted job, including watchdog adjustment. */
export function timerReceipt(job: JobInfo, requestedAt: number, deadline: number, request?: JsonValue): JsonValue {
  const value = request && typeof request === 'object' && !Array.isArray(request) ? request : {}
  const environment = value.environment && typeof value.environment === 'object' && !Array.isArray(value.environment) ? value.environment : {}
  let timezone = typeof environment.timezone === 'string' ? environment.timezone : 'UTC'
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() } catch { timezone = 'UTC' }
  const local = (at: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).format(at)
  return toJson({ ...job, requestedAt: new Date(requestedAt).toISOString(), scheduledAt: new Date(job.dueAt).toISOString(),
    scheduledLocal: local(job.dueAt), timezone, adjusted: job.dueAt !== requestedAt,
    adjustment: job.dueAt === requestedAt ? null : { reason: deadline <= Date.now() ? 'watchdog_overdue' : 'watchdog_deadline',
      latestWakeAt: new Date(deadline).toISOString() },
    delivery: 'persisted_and_published',
  })
}
