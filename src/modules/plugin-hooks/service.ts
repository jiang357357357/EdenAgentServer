import type { JobInfo } from '@eden/api'
import { DeferredJob } from '../jobs/index.ts'
import type { JobRepository } from '../jobs/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { pluginHookInstruction } from '../../model-prompts/plugin-hooks.ts'
import type { InstalledPackageRepository } from '../plugin-market/index.ts'
import { PluginHookRepository } from './repository.ts'
export class PluginHookService {
  private closed = false
  private queued = false
  private unsubscribe: (() => void) | undefined
  private error: string | undefined
  constructor(private readonly repository: PluginHookRepository, private readonly packages: InstalledPackageRepository,
    private readonly sessions: SessionService, private readonly jobs: JobRepository) {}
  get fault() { return this.error }
  start() {
    this.repository.initialize()
    this.unsubscribe = this.sessions.repository.events.subscribe(() => this.wake())
    this.wake()
  }
  close() { this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined }
  private wake() {
    if (this.closed || this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.closed) return
      try { if (this.repository.capture(this.packages.hookContributions())) this.wake() }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); this.close() }
    })
  }
  resubmit(id: string, expectedUpdatedAt: number, note: string) {
    return this.repository.resubmit(id, expectedUpdatedAt, note, job => {
      this.resolve(job)
      this.sessions.repository.assertContextReady(job.sessionId!)
      if (this.sessions.repository.read(job.sessionId!).status !== 'active') throw new Error('Restore the hook session before resubmitting')
    })
  }
  private resolve(job: JobInfo) {
    if (this.closed) throw new Error('Plugin hook dispatcher is unavailable')
    const input = this.repository.assertEvent(job)
    const hook = this.packages.hookContributions().find(item => item.pluginId === input.pluginId && item.revision === input.revision && item.hookId === input.hookId)
    if (!hook || !job.sessionId || hook.skillName !== input.skillName || hook.event !== input.event) throw new Error('Plugin hook was disabled, changed or removed before dispatch')
    const skill = this.packages.skillContributions().find(item => item.pluginId === input.pluginId && item.revision === input.revision && item.snapshot.name === input.skillName)
    if (!skill) throw new Error('Pinned hook skill is no longer available')
    return { input, skill }
  }
  dispatch(job: JobInfo) {
    const { input, skill } = this.resolve(job)
    const prompt = pluginHookInstruction({ ...input, skillContent: skill.snapshot.content })
    try { this.sessions.submitJob(job.sessionId!, prompt, job.id, job.kind, accepted => this.jobs.completeInTransaction(job.id, accepted.inputId)) }
    catch (error) { if (error instanceof Error && /No model configured/.test(error.message)) throw new DeferredJob('Plugin hook waits for session model binding'); throw error }
  }
}
