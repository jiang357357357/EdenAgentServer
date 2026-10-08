import { executeSkillCode } from './code-execution.ts'
import type { SkillSnapshot } from './snapshot.ts'
import type { SkillCodeTool } from './code-manifest.ts'
import { readGitSnapshot } from './git-source.ts'
import { skillInspectSchema, skillCreateSchema } from '@eden/api'
import { readLocalSnapshot } from './snapshot.ts'
import { generatedSkillSnapshot } from './generated-snapshot.ts'
import { SkillRepository } from './repository.ts'
import { probeHostExecution, type ExternalCommandSandbox } from '@eden/execution'
import { SystemSkillCatalog } from './system-catalog.ts'
import path from 'node:path'
export class SkillService {
  private executionAvailable = false
  private refreshTimer?: ReturnType<typeof setInterval>
  private refreshing: Promise<void> | undefined
  private refreshFailure: string | undefined
  private readonly workspaces = new Map<string, SkillService>()
  private executionOwner: SkillService | undefined
  private systemRefresh: Promise<void> | undefined
  private systemLoaded = false

  forWorkspace(workspace: () => string, scopeKey: string): SkillService {
    const existing = this.workspaces.get(scopeKey)
    if (existing) return existing
    const project = new SystemSkillCatalog(() => {
      const root = workspace()
      return root ? ['.agents/skills', '.edenagent/skills'].map(relative => path.join(root, relative)) : []
    }, true)
    const service = new SkillService(this.repository.forWorkspace(workspace, () => project.list(), scopeKey === 'account-global' ? undefined : scopeKey), this.systemCatalog, project, this.external)
    service.executionOwner = this
    this.workspaces.set(scopeKey, service)
    void service.refresh().catch(() => {})
    return service
  }

  async releaseWorkspace(scopeKey: string): Promise<void> {
    const service = this.workspaces.get(scopeKey)
    this.workspaces.delete(scopeKey)
    await service?.close()
  }
  status() { return { error: this.refreshFailure ?? null, refreshing: Boolean(this.refreshing), codeToolsAvailable: this.codeToolsAvailable } }
  get catalogError() { return this.refreshFailure }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.abort.signal.throwIfAborted()
    const task = (async () => {
      const results = await Promise.allSettled([this.executionOwner ? this.executionOwner.refreshSystem(false) : this.refreshSystem(true), this.projectCatalog?.load(this.abort.signal)])
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) throw new Error(failures.map(result => String(result.reason instanceof Error ? result.reason.message : result.reason)).join('; '))
      this.refreshFailure = undefined
      await Promise.all([...this.workspaces.values()].map(service => service.refresh().catch(() => {})))
    })().catch(error => { this.refreshFailure = error instanceof Error ? error.message : String(error); throw error })
    this.refreshing = task
    void task.finally(() => { if (this.refreshing === task) this.refreshing = undefined }).catch(() => {})
    return task
  }
  private refreshSystem(force: boolean): Promise<void> {
    if (this.systemRefresh) return this.systemRefresh
    if (!this.systemCatalog || (!force && this.systemLoaded)) return Promise.resolve()
    const task = this.systemCatalog.load(this.abort.signal).then(() => { this.systemLoaded = true })
    this.systemRefresh = task
    void task.finally(() => { if (this.systemRefresh === task) this.systemRefresh = undefined }).catch(() => {})
    return task
  }
  get codeToolsAvailable(): boolean { return (this.executionOwner?.codeToolsAvailable ?? this.executionAvailable) && !this.abort.signal.aborted }
  async start() {
    await this.refresh()
    const result = await probeHostExecution()
    this.abort.signal.throwIfAborted()
    this.executionAvailable = result.available
    this.refreshTimer = setInterval(() => { void this.refresh().catch(() => {}) }, 2000)
    this.refreshTimer.unref()
  }
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  async close() {
    clearInterval(this.refreshTimer)
    this.abort.abort()
    await Promise.allSettled([...this.pending, ...(this.refreshing ? [this.refreshing] : []), ...[...this.workspaces.values()].map(service => service.close())])
    this.workspaces.clear()
  }
  constructor(readonly repository: SkillRepository, private readonly systemCatalog?: SystemSkillCatalog, private readonly projectCatalog?: SystemSkillCatalog, private readonly external?: ExternalCommandSandbox) {}
  execute(data: SkillSnapshot, tool: SkillCodeTool, input: unknown, signal: AbortSignal) {
    this.abort.signal.throwIfAborted()
    if (!this.codeToolsAvailable) throw new Error('Skill code execution is unavailable; restart the host')
    if (this.pending.size >= 4) throw new Error('Skill operation concurrency limit reached')
    const task = executeSkillCode(data, tool, input, AbortSignal.any([signal, this.abort.signal]), this.external)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => {})
    return task
  }
  inspect(raw: unknown) {
    this.abort.signal.throwIfAborted()
    if (this.pending.size >= 2) throw new Error('Two skill previews are already in progress')
    const task = this.inspectSource(raw)
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task)).catch(() => {})
    return task
  }
  private async inspectSource(raw: unknown) {
    const input = skillInspectSchema.parse(raw)
    const root = this.repository.target(input.scope)
    const result = input.sourceType === 'git'
      ? await readGitSnapshot(input.sourceUri, input.sourceRef ?? '', input.sourceSubpath ?? '', this.abort.signal)
      : { data: await readLocalSnapshot(input.sourceUri, input.sourceSubpath ?? ''), commit: '' }
    this.abort.signal.throwIfAborted()
    const { data } = result
    return this.repository.preview(data, { type: input.sourceType, uri: input.sourceUri, ref: result.commit || input.sourceRef || '', subpath: input.sourceSubpath ?? '' }, input.scope, root)
  }
  prepareCreate(raw: unknown) {
    this.abort.signal.throwIfAborted()
    const input = skillCreateSchema.parse(raw)
    const data = generatedSkillSnapshot(input)
    return this.repository.preview(data, { type: 'generated', uri: '', ref: '', subpath: '' }, 'user')
  }
  create(raw: unknown) {
    const preview = this.prepareCreate(raw)
    return this.repository.install(preview.previewID)
  }
}
