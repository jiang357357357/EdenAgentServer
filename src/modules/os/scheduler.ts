import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { logDiagnostic } from '../logging/index.ts'
import { readState, saveState } from './state-store.ts'
import { uuidPattern } from './contracts.ts'
import type { OsConfig, OsTarget } from './contracts.ts'
import { WakeSession } from './wake-session.ts'
import { WakeRoot } from './wake-root.ts'
import { CoreMemoScheduler } from './memo-scheduler.ts'
import type { OsCoreClient } from './core-client.ts'
import { accountKey } from '../accounts/index.ts'

export class OsScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly active = new Map<string, Promise<void>>()
  private readonly instance = randomUUID()
  private startedAt = Date.now()
  private startupPending = true
  private closed = false
  private readonly faults = new Map<string, string>()
  private readonly root: WakeRoot
  private readonly memos: CoreMemoScheduler
  private control: { enabled: boolean; updatedAt: number } | undefined
  constructor(private readonly config: OsConfig, private readonly target: OsTarget, core: Pick<OsCoreClient, 'request'>) {
    this.root = new WakeRoot(config, target); this.memos = new CoreMemoScheduler(config, core, target)
  }
  get fault(): string | undefined { return this.faults.values().next().value }
  get status(): 'unconfigured' | 'unavailable' | 'starting' | 'ready' | 'paused' | 'failed' {
    if (!this.config.identity) return 'unconfigured'
    if (this.closed || !this.timer) return 'unavailable'
    if ([...this.faults.keys()].some(key => key !== 'memos')) return 'failed'
    if (!this.target.ready() || !this.control) return 'starting'
    return this.control.enabled ? 'ready' : 'paused'
  }
  start() {
    if (this.closed || this.timer || !this.config.identity) return
    mkdirSync(path.join(this.config.wakeDir, 'sessions'), { recursive: true, mode: 0o700 })
    this.startedAt = Date.now(); this.startupPending = this.config.startupWakeEnabled
    this.pump()
    this.timer = setInterval(() => this.pump(), Math.min(10, this.config.controlSeconds) * 1000)
    this.timer.unref()
  }
  private pump() {
    if (this.closed) return
    this.run('memos', () => this.memos.tick())
    const phase = this.target.ready() && this.control ? this.control.enabled ? 'ready' : 'paused' : 'starting'
    try { this.publishLease(this.faults.has('coordinator') ? 'failed' : phase) }
    catch (error) { this.failure('coordinator', error); return }
    if (!this.target.ready()) return
    this.run('coordinator', async () => {
      this.control = await this.target.control()
      if (this.closed) return
      this.publishLease(this.control.enabled ? 'ready' : 'paused')
      if (!this.control.enabled) return
      this.dispatch()
    })
  }
  private dispatch() {
    const due = Date.now() >= this.startedAt + this.config.startupDelaySeconds * 1000
    if (due && this.target.ready()) this.run('root', async () => {
      const startup = this.startupPending; this.startupPending = false; await this.root.tick(startup)
    })
    for (const entry of readdirSync(path.join(this.config.wakeDir, 'sessions'), { withFileTypes: true }))
      if (entry.isDirectory() && uuidPattern.test(entry.name)) this.run(entry.name, () => new WakeSession(this.config, entry.name, this.target).tick())
  }
  private publishLease(state: 'starting' | 'ready' | 'paused' | 'failed') {
    saveState(path.join(this.config.wakeDir, 'session-protocol.json'), { protocolVersion: 2, sessionScopes: true,
      roleScopes: true, instance: this.instance, owner: 'eden-agent-ts', expiresAt: Date.now() + 30000,
      accountKey: accountKey(this.config.identity!.coreBaseUrl, this.config.identity!.userId), state,
      enabled: this.control?.enabled ?? null, controlUpdatedAt: this.control?.updatedAt ?? null,
      error: state === 'failed' ? this.faults.get('coordinator') ?? '自醒调度异常' : null })
  }
  private run(key: string, action: () => Promise<void>) {
    if (this.active.has(key)) return
    const task = action().then(() => { this.faults.delete(key) }, error => this.failure(key, error))
      .finally(() => { this.active.delete(key) })
    this.active.set(key, task)
  }
  private failure(key: string, error: unknown) {
    const message = error instanceof Error ? error.message : '后台调度失败'
    if (this.faults.get(key) !== message) logDiagnostic({ event: 'os.scheduler.failed', scope: key, message }, 'error')
    this.faults.set(key, message)
    if (key === 'coordinator' && !this.closed) {
      try { this.publishLease('failed') } catch { /* The fault is retained; an unwritable lease expires. */ }
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = undefined
    await Promise.allSettled(this.active.values())
    const filename = path.join(this.config.wakeDir, 'session-protocol.json')
    if (readState(filename).instance === this.instance) rmSync(filename, { force: true })
  }
}
