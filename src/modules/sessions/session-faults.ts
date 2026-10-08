import { isRuntimePersistenceFailure } from '@eden/runtime-pi'
import { safeLogText } from '../logging/index.ts'

export function sessionFailureReason(error: unknown): string {
  let value = error, message = String(error)
  const seen = new Set<unknown>()
  while (value instanceof Error && !seen.has(value) && seen.size < 8) {
    seen.add(value); message = value.message
    if (!value.cause) break
    value = value.cause
  }
  return safeLogText(message || '未知错误', 800)
}

/** Fatal runtime execution and fatal durable storage are separate boundaries. */
export function sessionStorageFailure(error: unknown): boolean {
  if (isRuntimePersistenceFailure(error)) return true
  const pending = [error], seen = new Set<unknown>()
  while (pending.length && seen.size < 32) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if ('code' in item && typeof item.code === 'string' && /^(ERR_SQLITE_|SQLITE_)/.test(item.code)) return true
    if ('cause' in item) pending.push(item.cause)
    if (item instanceof AggregateError) pending.push(...item.errors)
  }
  return false
}

export class SessionFaults {
  private readonly failures = new Map<string, unknown>()
  constructor(private readonly recover: (sessionId: string, reason: string) => void) {}
  get size() { return this.failures.size }
  has(sessionId: string) { return this.failures.has(sessionId) }
  record(sessionId: string, error: unknown): boolean {
    if (!sessionStorageFailure(error)) return false
    this.failures.set(sessionId, error)
    return true
  }
  assertCanSubmit(sessionId: string, allowRecovery: boolean): void {
    if (!this.failures.has(sessionId)) return
    const original = this.failures.get(sessionId)
    if (allowRecovery) {
      try { this.recover(sessionId, sessionFailureReason(original)); this.failures.delete(sessionId); return }
      catch (error) { this.failures.set(sessionId, error) }
    }
    throw new Error(`会话存储尚未恢复：${sessionFailureReason(this.failures.get(sessionId))}。修复后可再次发送，失败回合不会自动重放。`,
      { cause: this.failures.get(sessionId) })
  }
}
