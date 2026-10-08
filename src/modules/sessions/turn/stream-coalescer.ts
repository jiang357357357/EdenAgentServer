import { setImmediate } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import type { JsonValue } from '@eden/api'

type Payload = Record<string, JsonValue>
interface Update { kind: string; payload: Payload }
const deltaTypes = new Set(['text_delta', 'thinking_delta', 'toolcall_delta'])
const object = (value: JsonValue | undefined): value is Payload => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Event-driven sampling: no timer may write after the owning runtime has ended. */
export class StreamCoalescer {
  private pending: Update | undefined
  private streamKey: string | undefined
  private writtenAt = 0
  private updates = 0
  private failure: unknown
  private failed = false

  constructor(private readonly append: (kind: string, payload: JsonValue) => void,
    private readonly now: () => number = () => performance.now()) {}

  async event(kind: string, payload: JsonValue): Promise<void> {
    this.assertHealthy()
    const key = this.deltaKey(kind, payload)
    if (!key || !object(payload)) {
      this.flush()
      this.write(kind, payload)
      this.streamKey = undefined
      return
    }
    if (key !== this.streamKey) {
      this.flush()
      this.streamKey = key
      this.write(kind, structuredClone(payload))
      this.writtenAt = this.now()
    } else {
      const latest = structuredClone(payload)
      if (this.pending) {
        const previous = this.pending.payload.assistantMessageEvent as Payload
        const stream = latest.assistantMessageEvent as Payload
        stream.delta = String(previous.delta) + String(stream.delta)
      }
      this.pending = { kind, payload: latest }
      if (this.now() - this.writtenAt >= 100) this.flush()
    }
    // Await only after all synchronous state changes; resuming never performs a delayed write.
    if (++this.updates % 32 === 0) await setImmediate()
    this.assertHealthy()
  }

  flush(): void {
    this.assertHealthy()
    const update = this.pending
    this.pending = undefined
    if (!update) return
    this.write(update.kind, update.payload)
    this.writtenAt = this.now()
  }

  private deltaKey(kind: string, payload: JsonValue): string | undefined {
    if (!kind.endsWith('.message_update') || !object(payload) || !object(payload.message)
      || payload.message.role !== 'assistant' || typeof payload.messageId !== 'string') return undefined
    const stream = payload.assistantMessageEvent
    if (!object(stream) || !deltaTypes.has(String(stream.type)) || typeof stream.delta !== 'string') return undefined
    return JSON.stringify([kind, payload.messageId, payload.actor ?? null, stream.type, stream.contentIndex ?? null])
  }

  private write(kind: string, payload: JsonValue): void {
    try { this.append(kind, payload) }
    catch (error) {
      this.failure = error
      this.failed = true
      this.pending = undefined
      this.streamKey = undefined
      throw error
    }
  }

  private assertHealthy(): void {
    if (this.failed) throw this.failure
  }
}
