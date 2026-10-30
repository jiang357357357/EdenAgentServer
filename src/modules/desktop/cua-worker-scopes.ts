import { DesktopError, type DesktopDriver } from './contracts.ts'

interface Active { controller: AbortController; done: Promise<unknown> }
/** A scope cannot be destroyed underneath an in-flight FFI call. */
export class CuaWorkerScopes {
  private readonly runtimes = new Map<string, Promise<DesktopDriver>>()
  private readonly active = new Map<string, Set<Active>>()
  private readonly releasing = new Map<string, Promise<void>>()
  constructor(private readonly create: () => Promise<DesktopDriver>) {}
  async run<T>(scope: string, controller: AbortController, work: (driver: DesktopDriver) => Promise<T>): Promise<T> {
    if (this.releasing.has(scope)) throw new DesktopError('Cua 会话正在释放', 'CUA_SCOPE_CLOSING')
    let runtime = this.runtimes.get(scope)
    if (!runtime) {
      if (this.runtimes.size >= 128) throw new DesktopError('Cua 会话数量超过限制', 'CUA_SCOPE_LIMIT')
      runtime = this.create().catch(error => { this.runtimes.delete(scope); throw error })
      this.runtimes.set(scope, runtime)
    }
    const operations = this.active.get(scope) ?? new Set<Active>(); this.active.set(scope, operations)
    const done = runtime.then(driver => { controller.signal.throwIfAborted(); return work(driver) })
    const operation = { controller, done }; operations.add(operation)
    try { return await done } finally { operations.delete(operation) }
  }
  release(scope: string): Promise<void> {
    const previous = this.releasing.get(scope)
    if (previous) return previous
    const work = this.drain(scope).finally(() => { this.releasing.delete(scope) })
    this.releasing.set(scope, work); return work
  }
  private async drain(scope: string) {
    const operations = [...this.active.get(scope) ?? []]
    for (const operation of operations) operation.controller.abort(new DesktopError('Cua 会话已释放', 'CUA_SCOPE_RELEASED', 'unknown'))
    await Promise.allSettled(operations.map(operation => operation.done))
    const runtime = this.runtimes.get(scope)
    this.runtimes.delete(scope); this.active.delete(scope)
    if (runtime) await (await runtime).close()
  }
  async close() { await Promise.allSettled([...this.runtimes.keys()].map(scope => this.release(scope))) }
}
