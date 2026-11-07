import { logDiagnostic } from '../logging/index.ts'
import type { ExternalCommandSandbox } from '@eden/execution'
import type { InstalledPackageRepository } from '../plugin-market/index.ts'
import { connectMcpStdio } from './stdio-runtime.ts'
import { connectMcpHttp } from './http-runtime.ts'
import { McpToolCatalog } from './tool-catalog.ts'
import { setTimeout as delay } from 'node:timers/promises'
type Runtime = Awaited<ReturnType<typeof connectMcpStdio>> | Awaited<ReturnType<typeof connectMcpHttp>>
type Component = ReturnType<InstalledPackageRepository['runtimePlan']>['runtimes'][number]
export class McpLifecycle {
  readonly catalog = new McpToolCatalog()
  private readonly abort = new AbortController()
  private readonly active = new Map<string, Runtime>()
  private readonly errors = new Map<string, string>()
  private readonly retry = new Map<string, number>()
  private readonly attempts = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private task: Promise<void> | undefined
  constructor(private readonly packages: InstalledPackageRepository, private readonly external?: ExternalCommandSandbox) { }
  list() {
    return {
      runtimes: [...this.active].map(([id, runtime]) => ({
        id, pluginId: runtime.component.pluginId, componentId: runtime.component.componentId,
        revision: runtime.component.revision, kind: runtime.component.kind,
        server: runtime.server.serverInfo
      })), errors: [...this.errors].map(([id, error]) => ({ id, error }))
    }
  }
  get(id: string, revision?: string) {
    const runtime = this.active.get(id)
    if (!runtime || (revision && runtime.component.revision !== revision))
      throw new Error(this.errors.get(id) ?? this.errors.get(id.split(':')[0]!) ?? 'MCP runtime is not available for this version')
    this.authorize(runtime.component)
    return runtime
  }
  start() {
    if (this.timer || this.abort.signal.aborted) return
    const tick = () => {
      if (this.task) return
      this.task = this.reconcile().catch(error => { logDiagnostic({ event: 'mcp.reconciliation.failed', message: 'MCP 组件状态同步失败。', error }, 'error') }).finally(() => { this.task = undefined })
    }
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick()
  }
  async waitForPackage(id: string, signal: AbortSignal, timeoutMs = 15_000, componentId?: string) {
    const current = this.packages.read(id), revision = current.revision
    const components = current.components.filter(item => (!componentId || item.id === componentId) && (item.kind === 'mcp_stdio' || item.kind === 'mcp_http'))
    const enabled = components.filter(item => item.enabled)
    if (!enabled.length) return { state: components.length ? 'disabled' : 'none', components: components.map(item => item.id) }
    // Reconcile immediately, but keep the readiness wait bounded even if initialization stalls.
    if (!this.task) this.task = this.reconcile().finally(() => { this.task = undefined })
    void this.task.catch(() => {})
    this.start()
    const deadline = Date.now() + timeoutMs
    while (true) {
      signal.throwIfAborted()
      const selected = this.packages.read(id)
      if (!selected.enabled || selected.revision !== revision) throw new Error('插件在等待后台就绪期间已停用或更新')
      if (enabled.every(item => this.active.get(`${id}:${item.id}`)?.component.revision === revision))
        return { state: 'ready', components: enabled.map(item => item.id) }
      if (!this.task) {
        const failures = [id, ...enabled.map(item => `${id}:${item.id}`)]
          .flatMap(key => this.errors.has(key) ? [{ component: key, error: this.errors.get(key)! }] : [])
        if (failures.length) return { state: 'failed', errors: failures }
      }
      if (Date.now() >= deadline) return { state: 'starting', components: enabled.map(item => item.id) }
      await delay(50, undefined, { signal })
    }
  }
  async ensureReady(runtimeId: string, signal: AbortSignal) {
    const [id, componentId, extra] = runtimeId.split(':')
    if (!id || !componentId || extra !== undefined) throw new Error('Invalid MCP runtime identity')
    try { this.get(runtimeId); return } catch { /* A selected runtime may still be initializing. */ }
    const result = await this.waitForPackage(id, signal, 15_000, componentId)
    if (result.state === 'ready') { this.get(runtimeId); return }
    if (result.state === 'failed') throw new Error(result.errors!.map(item => item.error).join('; '))
    if (result.state === 'starting') throw new Error('MCP 后台仍在启动，请稍后重新提交操作')
    throw new Error('MCP runtime is unavailable: component disabled or missing')
  }
  private authorize(component: Component) {
    this.abort.signal.throwIfAborted()
    if (!this.packages.runtimeSelections().some(row => row.id === component.pluginId && row.revision === component.revision)) throw new Error('MCP package version is not active')
    const plan = this.packages.runtimePlan(component.pluginId, component.revision)
    if (!plan.runtimes.some(item => item.componentId === component.componentId && item.kind === component.kind)) throw new Error('MCP component is disabled')
  }
  private async reconcile() {
    const selected = this.packages.runtimeSelections()
    for (const id of this.errors.keys()) if (!selected.some(item => id === item.id || id.startsWith(`${item.id}:`))) {
      this.errors.delete(id); this.retry.delete(id); this.attempts.delete(id)
    }
    for (const [id, runtime] of this.active) {
      try { this.authorize(runtime.component); if (runtime.takeCatalogChange()) await this.refreshCatalog(id, runtime) }
      catch { await runtime.close(); this.active.delete(id); this.catalog.remove(id) }
    }
    for (const selection of selected) {
      if (this.abort.signal.aborted) return
      let plan: ReturnType<InstalledPackageRepository['runtimePlan']>
      try { plan = this.packages.runtimePlan(selection.id, selection.revision); this.errors.delete(selection.id) }
      catch (error) { this.errors.set(selection.id, error instanceof Error ? error.message : String(error)); continue }
      await this.connectComponents(plan)
    }

  }
  private async refreshCatalog(id: string, runtime: Runtime) {
    const definitions = await runtime.client.tools(this.abort.signal)
    this.authorize(runtime.component)
    this.catalog.replace(id, runtime.component.revision, runtime.component.pluginId, runtime.component.componentId, definitions)
  }
  async close() {
    if (this.timer) clearInterval(this.timer)
    this.abort.abort(); await this.task
    await Promise.allSettled([...this.active.values()].map(runtime => runtime.close()))
    for (const id of this.active.keys()) this.catalog.remove(id)
    this.active.clear()
  }

  private async connectComponents(plan: ReturnType<InstalledPackageRepository['runtimePlan']>) {

    for (const component of plan.runtimes) {
      const id = `${component.pluginId}:${component.componentId}`
      if (this.attempts.get(id) !== component.revision) {
        this.attempts.set(id, component.revision); this.retry.delete(id); this.errors.delete(id)
      }
      if (this.active.has(id) || this.active.size >= 8 || (this.retry.get(id) ?? 0) > Date.now()) continue
      try {
        const authorize = () => this.authorize(component)
        const runtime = component.kind === 'mcp_stdio'
          ? await connectMcpStdio(component, plan.files, authorize, this.abort.signal, this.external)
          : await connectMcpHttp(component, authorize, this.abort.signal)
        try { await this.refreshCatalog(id, runtime); authorize() } catch (error) { this.catalog.remove(id); await runtime.close(); throw error }
        this.active.set(id, runtime); this.errors.delete(id)
        void runtime.exited.finally(() => {
          if (this.active.get(id) === runtime) { this.active.delete(id); this.catalog.remove(id) }
          if (this.attempts.get(id) === component.revision) this.retry.set(id, Date.now() + 15000)
        }).catch(error => { logDiagnostic({ event: 'mcp.exit.cleanup_failed', message: 'MCP 组件退出清理失败。', componentId: id, error }, 'error') })
      } catch (error) {
        this.retry.set(id, Date.now() + 15000)
        this.errors.set(id, `MCP 后台启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

  }
}
