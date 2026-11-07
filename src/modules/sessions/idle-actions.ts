interface Action { controller: AbortController; promise: Promise<unknown> }

/** Reserves an idle conversation while a user-operated extension performs a tool action. */
export class SessionIdleActions {
  private readonly actions = new Map<string, Action>()
  has(sessionId: string) { return this.actions.has(sessionId) }
  get size() { return this.actions.size }
  run<T>(sessionId: string, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>, settled: () => void): Promise<T> {
    if (this.actions.has(sessionId)) return Promise.reject(new Error('A conversation action is already running'))
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal) })
      .finally(() => { signal.removeEventListener('abort', abort); this.actions.delete(sessionId); settled() })
    this.actions.set(sessionId, { controller, promise })
    return promise
  }
  cancel(sessionId: string) {
    const action = this.actions.get(sessionId)
    action?.controller.abort(new Error('Conversation action cancelled'))
    return Boolean(action)
  }
  async wait(sessionId: string) { await Promise.allSettled([this.actions.get(sessionId)?.promise]) }
  async close() {
    for (const action of this.actions.values()) action.controller.abort(new Error('Conversation service closed'))
    await Promise.allSettled([...this.actions.values()].map(action => action.promise))
  }
}
