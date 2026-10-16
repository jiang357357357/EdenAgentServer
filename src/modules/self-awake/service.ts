import { logDiagnostic } from '../logging/index.ts'
import { recentSharedTopics } from '../sessions/index.ts'
import { toJson } from '@eden/api'
import type { JobInfo } from '@eden/api'
import { DeferredJob } from '../jobs/index.ts'
import type { JobRepository } from '../jobs/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { SelfAwakeRepository } from './repository.ts'
import { selfAwakePrompt, selfAwakeRequest } from './prompt.ts'
import { SelfAwakeJobRecovery } from './job-recovery.ts'

export class SelfAwakeService {
  readonly recovery: SelfAwakeJobRecovery
  private unsubscribe: (() => void) | undefined
  private closed = false
  private queued = false
  private error: string | undefined
  constructor(readonly repository: SelfAwakeRepository, private readonly jobs: JobRepository, private readonly sessions: SessionService) {
    this.recovery = new SelfAwakeJobRecovery(repository.database, jobs, sessions)
  }
  get fault(): string | undefined { return this.error ?? this.repository.timerPublication.fault }

  start(): void {
    if (this.unsubscribe || this.closed) return
    this.repository.roles.reconcile(this.sessions.repository, this.jobs)
    this.repository.timerPublication.start()
    this.unsubscribe = this.sessions.repository.events.subscribe(event => {
      if (event.kind.startsWith('input.') || event.kind.startsWith('turn.')) this.wake()
    })
    this.wake()
  }
  close(): void { this.repository.timerPublication.close(); this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined }

  dispatch(job: JobInfo): void {
    if (this.closed) throw new Error('Self-awake service is closed')
    if (!job.sessionId) throw new Error('Self-awake job requires a session')
    const session = this.sessions.repository.read(job.sessionId)
    if (session.status !== 'active') throw new Error('Self-awake session is not active')
    if (session.participants.length > 1) throw new Error('Self-awake requires a single acting character')
    const author = session.participants[0] ?? {}
    const recovery = this.recovery.assertDispatch(job, author, session.environment)
    const topics = recentSharedTopics(this.repository.database, job.sessionId, author)
    const request = toJson({ current_time: new Date().toISOString(), recent_conversation: topics, wakeSchedule: this.repository.wakeSchedule(job.sessionId), ...selfAwakeRequest(job, author, session.environment), merged_plans: this.repository.roles.merged(job.sessionId), ...(recovery ? { recovery } : {}) })
    const id = this.repository.begin(job, request, author)
    try {
      this.sessions.submitJob(job.sessionId, selfAwakePrompt(request), job.id, job.kind, input => {
        this.repository.dispatchedInTransaction(id, input.inputId, input.turnId)
        this.jobs.completeInTransaction(job.id, input.inputId)
      }, topics.map(topic => topic.userText).join("\n"))
    } catch (error) {
      if (error instanceof Error && /No model configured/.test(error.message)) throw new DeferredJob('Self-awake is waiting for its session model binding')
      this.repository.fail(id, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private wake(): void {
    if (this.queued || this.closed) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.closed) return
      try {
        const results = this.repository.pendingResults()
        for (const result of results) {
          try { this.finishResult(result) }
          catch (error) {
            this.repository.fail(result.id, error instanceof Error ? error.message : String(error))
            logDiagnostic({ event: 'self_awake.completion.failed', message: '本会话自醒结果处理失败。', runId: result.id, origin: this.sessions.repository.origin, error }, 'error')
          }
        }
        if (results.length === 100) this.wake()
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.close()
        logDiagnostic({ event: 'self_awake.completion.stopped', message: '自醒完成结果处理已停止。', origin: this.sessions.repository.origin, error }, 'error')
      }
    })
  }

  private finishResult(result: ReturnType<SelfAwakeRepository['pendingResults']>[number]): void {
    const run = this.repository.read(result.id)
    if (result.state !== 'completed') { this.repository.fail(result.id, this.repository.inputFailure(run.sessionId, result.inputId, result.state)); return }
    const text = this.repository.finalText(run.sessionId, result.turnId)
    if (!text.trim() && !run.diaries.length) { this.repository.fail(result.id, '自醒完成但没有日记正文'); return }
    this.repository.finish(result.id, text)
  }
}
