import { performance } from 'node:perf_hooks'
import type { ReplyTimerSnapshot, SessionEvent } from '@eden/api'

/** Server times are authoritative; a monotonic local clock only animates a live turn. */
export class ReplyClock {
  private snapshot: ReplyTimerSnapshot | undefined
  private receivedAt = 0
  private connected = false
  private elapsed = 0
  private readonly tools = new Set<string>()
  private readonly models = new Set<string>()

  constructor(private readonly now: () => number = () => performance.now()) {}

  get running(): boolean { return this.snapshot?.turn?.outcome === 'running' }

  reset(): void { this.snapshot = undefined; this.elapsed = 0; this.tools.clear(); this.models.clear() }

  connection(connected: boolean): void {
    this.elapsed = this.read().elapsedMs ?? 0
    this.receivedAt = this.now()
    this.connected = connected
  }

  restore(snapshot: ReplyTimerSnapshot): void {
    if (this.snapshot && BigInt(snapshot.seq) < BigInt(this.snapshot.seq)) return
    this.snapshot = snapshot; this.receivedAt = this.now()
    const turn = snapshot.turn
    this.elapsed = turn ? Math.max(0, (turn.finishedAt ?? snapshot.observedAt) - turn.startedAt) : 0
    this.tools.clear(); this.models.clear()
    for (const id of snapshot.breakdown?.tools.activeIds ?? []) this.tools.add(id)
    for (const id of snapshot.breakdown?.thinking.activeIds ?? []) this.models.add(id)
  }

  observe(event: SessionEvent): void {
    if (this.snapshot && BigInt(event.seq) <= BigInt(this.snapshot.seq)) return
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
    if (event.eventType === 'turn.started' && event.turnId) {
      this.restore({ seq: event.seq, observedAt: event.createdAt,
        turn: { turnId: event.turnId, startedAt: event.createdAt, outcome: 'running' } })
      return
    }
    const previous = this.snapshot
    if (!previous?.turn || event.turnId !== previous.turn.turnId) return
    const turn = { ...previous.turn }
    const endings = { 'turn.completed': 'completed', 'turn.failed': 'failed', 'input.interrupted': 'interrupted' } as const
    const ending = endings[event.eventType as keyof typeof endings]
    if (ending) { turn.outcome = ending; turn.finishedAt = Math.max(turn.startedAt, event.createdAt) }
    this.snapshot = { ...previous, turn, seq: event.seq, observedAt: event.createdAt }
    this.elapsed = Math.max(this.elapsed, Math.max(0, (turn.finishedAt ?? event.createdAt) - turn.startedAt))
    this.receivedAt = this.now()
    this.phase(event.eventType, payload)
    if (ending) { this.tools.clear(); this.models.clear() }
  }

  private phase(kind: string, payload: Record<string, unknown>): void {
    const id = kind.startsWith('operation.') ? payload.callId : payload.requestId
    if (typeof id !== 'string') return
    if (kind === 'operation.started') this.tools.add(id)
    if (kind === 'operation.completed') this.tools.delete(id)
    if (kind === 'model.request') this.models.add(id)
    if (kind === 'model.response') this.models.delete(id)
  }

  read(): { elapsedMs?: number; phase: string } {
    const turn = this.snapshot?.turn
    if (!turn) return { phase: '就绪' }
    const elapsedMs = this.elapsed + (this.running && this.connected ? Math.max(0, this.now() - this.receivedAt) : 0)
    const phase = this.running ? this.tools.size ? '执行工具' : this.models.size ? '等待模型' : '正在处理'
      : turn.outcome === 'completed' ? '本轮完成' : turn.outcome === 'failed' ? '本轮失败' : '本轮中断'
    return { elapsedMs, phase }
  }
}
