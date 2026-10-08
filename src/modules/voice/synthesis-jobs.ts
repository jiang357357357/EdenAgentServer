import { OperationFailure } from '@eden/api'

interface Job<T> {
  key: string; owner: string; controller: AbortController; promise: Promise<T>; consumers: Set<string>
  execute(signal: AbortSignal): Promise<T>; resolve(value: T): void; reject(error: unknown): void
  state: 'queued' | 'running' | 'done'; timer: ReturnType<typeof setTimeout>
}
interface SynthesisLimits { concurrency: number; pending: number; queueTimeoutMs: number; executionTimeoutMs: number }
const defaults: SynthesisLimits = { concurrency: 2, pending: 32, queueTimeoutMs: 60000, executionTimeoutMs: 120000 }

/** Bounded account-scoped queue; unrelated sessions take turns, shared consumers cancel independently. */
export class SynthesisJobs<T> {
  private readonly jobs = new Map<string, Job<T>>()
  private readonly requests = new Map<string, AbortController>()
  private active = 0
  private previousOwner = ''
  private closed = false
  private readonly limits: SynthesisLimits
  constructor(limits: Partial<SynthesisLimits> = {}) {
    this.limits = { ...defaults, ...limits }
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid speech queue limits')
  }

  async run(key: string, request: string, execute: (signal: AbortSignal) => Promise<T>, owner = request.split(':')[0]!): Promise<T> {
    if (this.closed) throw new Error('Speech service closed')
    if (this.requests.has(request)) throw new Error('Duplicate speech request ID')
    const job = this.jobs.get(key) ?? this.enqueue(key, owner, execute)
    const controller = new AbortController()
    this.requests.set(request, controller); job.consumers.add(request)
    this.pump()
    let cancel: () => void = () => {}
    try {
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('Speech synthesis cancelled'))
        controller.signal.addEventListener('abort', cancel, { once: true })
      })
      return await Promise.race([job.promise, cancelled])
    } finally {
      controller.signal.removeEventListener('abort', cancel)
      this.requests.delete(request); job.consumers.delete(request)
      if (!job.consumers.size && job.state !== 'done') job.controller.abort(new Error('Speech synthesis cancelled'))
    }
  }

  private enqueue(key: string, owner: string, execute: Job<T>['execute']) {
    if (this.jobs.size >= this.limits.pending + this.limits.concurrency) {
      throw new OperationFailure('语音队列已满，请稍后手动重试。', { kind: 'speech_queue_full', retryable: false, outcome: 'failed' })
    }
    let resolve!: Job<T>['resolve'], reject!: Job<T>['reject']
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    const job: Job<T> = { key, owner, execute, promise, resolve, reject, controller: new AbortController(), consumers: new Set(),
      state: 'queued', timer: setTimeout(() => this.timeout(job, 'queue'), this.limits.queueTimeoutMs) }
    job.controller.signal.addEventListener('abort', () => this.finish(job, undefined, job.controller.signal.reason), { once: true })
    this.jobs.set(key, job)
    return job
  }

  private pump() {
    if (this.closed) return
    while (this.active < this.limits.concurrency) {
      const queued = [...this.jobs.values()].filter(job => job.state === 'queued' && job.consumers.size)
      const job = queued.find(job => job.owner !== this.previousOwner) ?? queued[0]
      if (!job) return
      this.previousOwner = job.owner
      clearTimeout(job.timer); job.state = 'running'; this.active++
      job.timer = setTimeout(() => this.timeout(job, 'execution'), this.limits.executionTimeoutMs)
      void Promise.resolve().then(() => { job.controller.signal.throwIfAborted(); return job.execute(job.controller.signal) })
        .then(value => this.finish(job, value), error => this.finish(job, undefined, error))
    }
  }
  private timeout(job: Job<T>, phase: string) {
    job.controller.abort(new OperationFailure(phase === 'queue' ? '语音排队超时，请稍后手动重试。' : '语音合成超时，请核对结果后手动重试。',
      { kind: 'speech_timeout', retryable: false, outcome: phase === 'queue' ? 'failed' : 'unknown' }))
  }
  private finish(job: Job<T>, value?: T, error?: unknown) {
    if (job.state === 'done') return
    if (job.state === 'running') this.active--
    job.state = 'done'; clearTimeout(job.timer)
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    if (error !== undefined) job.reject(error); else job.resolve(value as T)
    queueMicrotask(() => this.pump())
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
    for (const job of pending) job.controller.abort(new Error('Speech synthesis cancelled'))
    await Promise.allSettled(pending.map(job => job.promise))
  }
}
