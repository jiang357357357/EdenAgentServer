interface Job<T> { controller: AbortController; promise: Promise<T>; consumers: Set<string> }

/** Cancel one requester; abort shared upstream work only after its last requester leaves. */
export class SynthesisJobs<T> {
  private readonly jobs = new Map<string, Job<T>>()
  private readonly requests = new Map<string, AbortController>()
  private closed = false

  async run(key: string, request: string, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Speech service closed')
    if (this.requests.has(request)) throw new Error('Duplicate speech request ID')
    let job = this.jobs.get(key)
    if (!job) {
      if (this.jobs.size >= 2) throw new Error('Speech synthesis concurrency limit reached')
      const controller = new AbortController()
      job = { controller, consumers: new Set(), promise: Promise.resolve().then(() => execute(controller.signal)) }
      this.jobs.set(key, job)
      const owned = job
      void job.promise.finally(() => { if (this.jobs.get(key) === owned) this.jobs.delete(key) }).catch(() => {})
    }
    const controller = new AbortController(), owned = job
    this.requests.set(request, controller); job.consumers.add(request)
    let cancel: () => void = () => {}
    try {
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('Speech synthesis cancelled'))
        controller.signal.addEventListener('abort', cancel, { once: true })
      })
      return await Promise.race([job.promise, cancelled])
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      this.requests.delete(request); owned.consumers.delete(request)
      if (!owned.consumers.size) {
        owned.controller.abort()
        if (this.jobs.get(key) === owned) this.jobs.delete(key)
      }
    }
  }

  cancel(request: string) {
    const controller = this.requests.get(request)
    controller?.abort()
    return Boolean(controller)
  }

  async close() {
    this.closed = true
    const pending = [...this.jobs.values()]
    for (const controller of this.requests.values()) controller.abort()
    for (const job of pending) job.controller.abort()
    await Promise.allSettled(pending.map(job => job.promise))
  }
}
