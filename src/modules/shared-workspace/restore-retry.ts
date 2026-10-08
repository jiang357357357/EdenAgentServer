interface Failure { message: string; attempts: number; retryAt: number }

/** Retry restoration without repeating the same warning on every authenticated connection. */
export class SharedRestoreRetry {
  private readonly failures = new Map<string, Failure>()
  constructor(private readonly now = Date.now, private readonly initialDelay = 30_000, private readonly maximumDelay = 300_000) {}

  canAttempt(key: string): boolean { return (this.failures.get(key)?.retryAt ?? 0) <= this.now() }
  succeeded(key: string): void { this.failures.delete(key) }
  failed(key: string, message: string): boolean {
    const previous = this.failures.get(key), attempts = Math.min((previous?.attempts ?? 0) + 1, 16)
    const delay = Math.min(this.maximumDelay, this.initialDelay * 2 ** (attempts - 1))
    this.failures.set(key, { message, attempts, retryAt: this.now() + delay })
    return previous?.message !== message
  }
  delay(key?: string): number | undefined {
    const values = key ? [this.failures.get(key)].filter(value => value !== undefined) : [...this.failures.values()]
    if (!values.length) return undefined
    return Math.max(0, Math.min(...values.map(value => value.retryAt)) - this.now())
  }
}
