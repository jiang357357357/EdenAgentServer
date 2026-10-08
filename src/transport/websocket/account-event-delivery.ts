import { setImmediate } from 'node:timers/promises'
import type { DurableEvent } from '@eden/api'
import type { AccountConnection } from '../../modules/accounts/index.ts'
import type { PendingEventRange } from '../../modules/sessions/index.ts'
import { wireEvent } from '../rpc/session.routes.ts'

/** Keep only unseen sequence ranges; event payloads remain in the account's durable store. */
export class AccountEventDelivery {
  private readonly pending = new Map<string, PendingEventRange>()
  private refreshing: Promise<void> | undefined
  private pumping: Promise<void> | undefined
  private closed = false

  constructor(private readonly account: Pick<AccountConnection, 'active' | 'refresh'> | undefined,
    private readonly send: (serialized: string) => Promise<void>,
    private readonly close: (code: number, reason: string) => void,
    private readonly readPending: (ranges: readonly PendingEventRange[]) => DurableEvent | undefined) {}

  publish(event: DurableEvent): void {
    if (this.closed) return
    const range = this.pending.get(event.sessionId)
    if (range) {
      if (BigInt(event.seq) > BigInt(range.throughSeq)) range.throughSeq = event.seq
    } else {
      this.pending.set(event.sessionId, { sessionId: event.sessionId,
        afterSeq: String(BigInt(event.seq) - 1n), throughSeq: event.seq })
    }
    this.kick()
  }

  replay(sessionId: string, afterSeq: string, throughSeq: string): void {
    if (this.closed || BigInt(afterSeq) >= BigInt(throughSeq)) return
    const current = this.pending.get(sessionId)
    this.pending.set(sessionId, { sessionId,
      afterSeq: current && BigInt(current.afterSeq) < BigInt(afterSeq) ? current.afterSeq : afterSeq,
      throughSeq: current && BigInt(current.throughSeq) > BigInt(throughSeq) ? current.throughSeq : throughSeq })
    this.kick()
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Account event stream is closed'))
    if (this.refreshing) return this.refreshing
    const pending = (this.account?.refresh() ?? Promise.resolve()).then(() => {
      this.refreshing = undefined
      if (this.closed) throw new Error('Account event stream closed during verification')
      this.kick()
    }, error => {
      this.refreshing = undefined
      this.stop(1008, 'Core account authentication failed')
      throw error
    })
    this.refreshing = pending
    return pending
  }

  dispose(): void {
    this.closed = true
    this.pending.clear()
  }

  private kick(): void {
    if (this.closed || !this.pending.size || this.pumping) return
    if (this.account && !this.account.active()) {
      void this.refresh().catch(() => {}) // refresh owns authentication failure and connection cleanup.
      return
    }
    // Let the current synchronous publication batch finish before reading persisted events.
    const task = setImmediate().then(() => this.flush())
    this.pumping = task
    void task.then(() => {
      this.pumping = undefined
      this.kick()
    }, () => {
      this.pumping = undefined
      this.stop(1011, 'Durable event delivery failed')
    })
  }

  private async flush(): Promise<void> {
    let delivered = 0
    while (!this.closed && this.pending.size && (!this.account || this.account.active())) {
      const event = this.readPending([...this.pending.values()])
      if (!event) throw new Error('Pending durable event is missing')
      const range = this.pending.get(event.sessionId)
      if (!range || BigInt(event.seq) !== BigInt(range.afterSeq) + 1n || BigInt(event.seq) > BigInt(range.throughSeq))
        throw new Error('Pending durable event sequence is inconsistent')
      await this.send(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: wireEvent(event) }))
      if (this.closed) return
      range.afterSeq = event.seq
      if (range.afterSeq === range.throughSeq) this.pending.delete(event.sessionId)
      // Even a fast sender must allow other connections and account refresh timers to progress.
      if (++delivered % 32 === 0) await setImmediate()
    }
  }

  private stop(code: number, reason: string): void {
    if (this.closed) return
    this.dispose()
    this.close(code, reason)
  }
}
