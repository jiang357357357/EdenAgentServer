import { jsonSnapshot } from '@eden/api'
import type { DurableEvent, JsonValue } from '@eden/api'
import { isObject } from './message-delta.ts'
import { restoreMessage, restorePartial, storeMessage, storePartial } from './message-storage.ts'

const format = 'eden.message.delta.v2'
const legacyFormat = 'eden.message.delta.v1'
const snapshotInterval = 128
interface Previous { seq: string; message: JsonValue; partial?: JsonValue; depth: number }

/** Compact only on disk. Public events retain their original, independently renderable payload. */
export class StreamPersistence {
  private readonly previous = new Map<string, Previous>()

  encode(event: DurableEvent): JsonValue {
    const payload = event.payload
    if (!event.kind.endsWith('.message_update') || !isObject(payload) || !isObject(payload.message)) return payload
    const stream = payload.assistantMessageEvent
    if (!isObject(stream)) return payload
    const previous = this.previous.get(this.key(event))
    const { message, assistantMessageEvent: _stream, ...rest } = payload
    const { partial: _partial, ...update } = stream
    const base = previous && previous.depth < snapshotInterval && BigInt(previous.seq) < BigInt(event.seq) ? previous : undefined
    const storage = storeMessage(message, base && { seq: base.seq, value: base.message })
    if (Object.hasOwn(stream, 'partial')) storage.partial = storePartial(message, stream.partial!,
      base?.partial !== undefined ? { seq: base.seq, value: base.partial } : undefined)
    return jsonSnapshot({ ...rest, assistantMessageEvent: update, messageStorage: { format, ...storage } })
  }

  committed(event: DurableEvent): void {
    const payload = event.payload
    if (!isObject(payload)) return
    const key = this.key(event)
    if (event.kind.endsWith('.message_end')) { this.previous.delete(key); return }
    if (['turn.completed', 'turn.failed', 'input.interrupted'].includes(event.kind)) {
      const prefix = `${event.sessionId}:${event.turnId}:`
      for (const candidate of this.previous.keys()) if (candidate.startsWith(prefix)) this.previous.delete(candidate)
      return
    }
    if (!event.kind.endsWith('.message_start') && !event.kind.endsWith('.message_update')) return
    if (!isObject(payload.message) || payload.message.role !== 'assistant') return
    this.remember(event, payload, key)
  }

  private remember(event: DurableEvent, payload: Record<string, JsonValue>, key: string): void {
    const previous = this.previous.get(key)
    if (previous && BigInt(previous.seq) >= BigInt(event.seq)) return
    const stream = payload.assistantMessageEvent
    this.previous.set(key, { seq: event.seq, message: jsonSnapshot(payload.message),
      ...(isObject(stream) && Object.hasOwn(stream, 'partial') ? { partial: jsonSnapshot(stream.partial) } : {}),
      depth: previous && previous.depth < snapshotInterval ? previous.depth + 1 : 0 })
  }

  private key(event: DurableEvent): string {
    const payload = isObject(event.payload) ? event.payload : {}
    return `${event.sessionId}:${event.turnId}:${String(payload.messageId ?? '')}`
  }
}

export function restoreStreamPayload(payload: JsonValue, previous: (seq: string) => JsonValue): JsonValue {
  if (!isObject(payload) || !isObject(payload.messageStorage) || ![format, legacyFormat].includes(String(payload.messageStorage.format))) return payload
  const { messageStorage: storage, ...rest } = payload
  const basePayload = (seq: JsonValue | undefined) => {
    if (typeof seq !== 'string') throw new Error('Invalid persisted message delta sequence')
    const base = previous(seq)
    if (!isObject(base) || !isObject(base.message) || base.messageId !== payload.messageId) throw new Error('Missing persisted message delta base')
    return base
  }
  const message = restoreMessage(storage, () => basePayload(storage.baseSeq).message!)
  if (!isObject(rest.assistantMessageEvent)) throw new Error('Invalid persisted stream event')
  const stream = { ...rest.assistantMessageEvent }
  if (storage.format === legacyFormat) stream.partial = message
  else if (Object.hasOwn(storage, 'partial')) stream.partial = restorePartial(storage.partial!, message, () => {
    const partialStorage = storage.partial as Record<string, JsonValue>
    const baseStream = basePayload(partialStorage.baseSeq).assistantMessageEvent
    if (!isObject(baseStream) || !Object.hasOwn(baseStream, 'partial')) throw new Error('Missing persisted partial delta base')
    return baseStream.partial!
  })
  return { ...rest, message, assistantMessageEvent: stream }
}
