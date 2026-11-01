import { logDiagnostic } from '../logging/index.ts'
import type { SessionService } from '../sessions/index.ts'
import { dueMemoInstruction, memoRedeliveryInstruction } from '../../model-prompts/jobs.ts'
import type { MemoDeliveryRepository, PendingMemoDelivery } from './delivery-repository.ts'
import type { MemoDeliveryEffects } from './delivery-effects.ts'

/** The host wakes the role and settles actual communication receipts; it never chooses a channel. */
export class MemoDeliveryService {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private started = false
  private failure: string | undefined
  private readonly abort = new AbortController()
  constructor(private readonly repository: MemoDeliveryRepository, private readonly sessions: SessionService,
    private readonly effects: MemoDeliveryEffects) {}
  get fault(): string | undefined { return this.failure }

  start(): void {
    if (this.started || this.abort.signal.aborted) return
    this.repository.recover(); this.started = true; this.schedule(0)
  }

  async close(): Promise<void> {
    clearTimeout(this.timer); this.abort.abort()
    await this.active
  }

  private schedule(delay: number): void {
    if (this.abort.signal.aborted) return
    this.timer = setTimeout(() => {
      this.active = this.drain().catch(error => {
        this.failure = error instanceof Error ? error.message : String(error)
        logDiagnostic({ event: 'memo.delivery.stopped', message: '提醒投递服务已停止，请检查投递记录。', error }, 'error')
        this.abort.abort()
      }).finally(() => { this.active = undefined; this.schedule(1000) })
    }, delay)
    this.timer.unref()
  }

  async drain(): Promise<void> {
    for (let index = 0; index < 16 && !this.abort.signal.aborted; index++) {
      const delivery = this.repository.claim()
      if (!delivery) break
      this.wake(delivery)
    }
    for (const pending of this.repository.awaiting()) {
      if (this.abort.signal.aborted) break
      const receipt = await this.effects.outcome(pending.delivery.jobId, this.abort.signal)
      if (['queued', 'running', 'held'].includes(pending.state)) continue
      if (receipt?.state === 'pending') continue
      this.repository.finish(pending.delivery, receipt ?? {
        state: pending.state === 'cancelled' ? 'cancelled' : 'failed',
        error: '角色没有取得实际通信回执，提醒尚未投递。普通聊天回复不代表发送成功。',
      })
    }
  }

  private wake(delivery: PendingMemoDelivery): void {
    if (!this.repository.current(delivery)) {
      this.repository.finish(delivery, { state: 'cancelled', error: '提醒已修改或取消，原内容未发送。' }); return
    }
    const prompt = delivery.historical ? memoRedeliveryInstruction(delivery.memo) : dueMemoInstruction(delivery.memo)
    try {
      this.sessions.submitJob(delivery.sessionId, prompt, delivery.jobId,
        delivery.historical ? 'memo.reminder.redelivery' : 'memo.reminder',
        input => this.repository.attachInput(delivery, input.inputId))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/No model configured|model binding|provider/i.test(message)) this.repository.defer(delivery, message)
      else this.repository.finish(delivery, { state: 'failed', error: message })
    }
  }
}
