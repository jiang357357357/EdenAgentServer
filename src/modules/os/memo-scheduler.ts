import path from 'node:path'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { z } from 'zod'
import { readState, pendingRequests, saveState } from './state-store.ts'
import { iso, time } from './contracts.ts'
import type { OsConfig, State, ReminderTarget } from './contracts.ts'
import type { OsCoreClient } from './core-client.ts'

const dueMemo = z.object({ id: z.union([z.string(), z.number()]).transform(String), user: z.union([z.string(), z.number()]).transform(String),
  title: z.string().min(1).max(1000), content: z.string().max(64000), priority: z.enum(['low', 'normal', 'high']),
  trigger_at: z.string().refine(v => time(v) !== undefined), updated_at: z.string().refine(v => time(v) !== undefined) })
type DueMemo = z.infer<typeof dueMemo>

/** Core owns its memos; Agent owns durable reminder admission and actual notifications. */
export class CoreMemoScheduler {
  constructor(private readonly config: OsConfig, private readonly core: Pick<OsCoreClient, 'request'>, private readonly target: ReminderTarget) {}
  async tick(now = Date.now()) {
    const filename = path.join(this.config.memoDir, 'state.json')
    const state = readState(filename, { enabled: true, next_wake_at: null, in_flight: {} })
    const requests = pendingRequests(path.join(this.config.memoDir, 'schedule_requests'))
    if (!requests.length && now - (time(state.last_reconciled_at) ?? 0) < this.config.memoReconcileSeconds * 1000) {
      if (state.last_error) throw new Error(String(state.last_error))
      return
    }
    const result = await this.core.request('POST', '/api/memos/dispatch-due/', { before: iso(now), limit: this.config.memoBatchSize, mark_dispatched: false })
    const memos = z.array(dueMemo).max(100).parse(result.memos), inFlight: State = {}
    for (const memo of memos) {
      if (memo.user !== this.config.identity!.userId) throw new Error('Core 备忘事项账号不匹配')
      const key = `core-memo:${createHash('sha256').update(`${memo.user}:${memo.id}:${memo.trigger_at}:${memo.updated_at}`).digest('hex')}`
      const old = state.in_flight?.[memo.id]
      const delivery = old?.key === key ? old : { key, trigger_at: memo.trigger_at, revision: memo.updated_at }
      inFlight[memo.id] = delivery
      try { await this.deliver(memo, delivery, now) }
      catch (error) { delivery.error = error instanceof Error ? error.message : '备忘提醒投递失败' }
      // Admission keys are deterministic across a crash before this snapshot.
      saveState(filename, { ...state, in_flight: { ...state.in_flight, ...inFlight } })
    }
    Object.assign(state, { enabled: true, last_reconciled_at: iso(now), last_dispatch_at: iso(now), last_due_count: memos.length,
      last_error: Object.values(inFlight).find(value => value.error)?.error ?? '', next_wake_at: result.next_wake_at ?? null, in_flight: inFlight })
    saveState(filename, state)
    if (state.last_error) throw new Error(String(state.last_error))
    for (const request of requests) rmSync(request.filename)
  }
  private async deliver(memo: DueMemo, delivery: State, now: number) {
    if (!delivery.agent_memo_id) {
      const accepted = await this.target.admitReminder({ key: delivery.key, sourceId: memo.id, title: memo.title, content: memo.content,
        priority: memo.priority, at: time(memo.trigger_at)! })
      delivery.agent_memo_id = accepted.memoId; delivery.submitted_at = iso(now)
    }
    const delivered = await this.target.reminderDelivery(delivery.agent_memo_id)
    if (delivered !== null) {
      await this.core.request('POST', `/api/memos/${encodeURIComponent(memo.id)}/ack-dispatch/`, {
        expected_trigger_at: memo.trigger_at, expected_updated_at: memo.updated_at, delivered_at: iso(delivered) })
      delivery.delivered_at = iso(delivered)
    }
    delivery.error = ''
  }
}
