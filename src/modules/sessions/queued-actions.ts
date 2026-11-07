interface QueuedAction {
  removed: Promise<void>
  start(reserve: (signal: AbortSignal, action: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown>): void
  cancel(): void
}

/** User-operated tools reserve the next idle boundary, without replaying an operation. */
export class SessionQueuedActions {
  private readonly queues = new Map<string, QueuedAction[]>()
  private closed = false
  has(sessionId: string) { return Boolean(this.queues.get(sessionId)?.length) }
  enqueue<T>(sessionId: string, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>, schedule: () => void): Promise<T> {
    signal.throwIfAborted()
    if (this.closed) return Promise.reject(new Error('Conversation service closed'))
    return new Promise<T>((resolve, reject) => {
      let removed: () => void = () => {}
      const removal = new Promise<void>(finish => { removed = finish })
      const remove = () => {
        signal.removeEventListener('abort', abort)
        const queue = this.queues.get(sessionId)
        const index = queue?.indexOf(entry) ?? -1
        if (index >= 0) queue!.splice(index, 1)
        if (!queue?.length) this.queues.delete(sessionId)
        removed()
      }
      const abort = () => { remove(); reject(signal.reason ?? new Error('Conversation action cancelled')) }
      const entry: QueuedAction = {
        removed: removal,
        start: reserve => {
          remove()
          try { signal.throwIfAborted(); void reserve(signal, action).then(value => resolve(value as T), reject) }
          catch (error) { reject(error); queueMicrotask(schedule) }
        },
        cancel: () => { remove(); reject(new Error('Conversation action cancelled')) },
      }
      const queue = this.queues.get(sessionId) ?? []
      queue.push(entry); this.queues.set(sessionId, queue)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else schedule()
    })
  }
  start(sessionId: string, reserve: Parameters<QueuedAction['start']>[0]): boolean {
    const entry = this.queues.get(sessionId)?.[0]
    if (!entry) return false
    entry.start(reserve)
    return true
  }
  cancel(sessionId: string): boolean {
    const entries = [...this.queues.get(sessionId) ?? []]
    for (const entry of entries) entry.cancel()
    return entries.length > 0
  }
  async wait(sessionId: string) { await Promise.all(this.queues.get(sessionId)?.map(entry => entry.removed) ?? []) }
  close() { this.closed = true; for (const sessionId of this.queues.keys()) this.cancel(sessionId) }
}
