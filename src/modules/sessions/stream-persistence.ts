import { toJson } from '@eden/api'
import type { DurableEvent, JsonValue } from '@eden/api'
import { applyMessagePatches, isObject, messagePatches } from './message-delta.ts'
import type { MessagePatch } from './message-delta.ts'

const format = 'eden.message.delta.v1'
const snapshotInterval = 128
interface Previous { seq: string; message: JsonValue; depth: number }

/** Compact only on disk. Public events retain their original, independently renderable payload. */
export class StreamPersistence {
  private readonly previous = new Map<string, Previous>()

  encode(event: DurableEvent): JsonValue {
    const payload = event.payload
    if (!event.kind.endsWith('.message_update') || !isObject(payload) || !isObject(payload.message)) return payload
    const stream = payload.assistantMessageEvent
    if (!isObject(stream) || JSON.stringify(stream.partial) !== JSON.stringify(payload.message)) return payload
    const previous = this.previous.get(this.key(event))
    const { message, assistantMessageEvent: _stream, ...rest } = payload
    const { partial: _partial, ...update } = stream
    const base = previous && previous.depth < snapshotInterval && BigInt(previous.seq) < BigInt(event.seq) ? previous : undefined
    const patches = base ? messagePatches(base.message, message) : undefined
    // A replacement can be larger than a snapshot (e.g. tool argument structure changes).
    const delta = patches && JSON.stringify(patches).length < JSON.stringify(message).length
    return toJson({ ...rest, assistantMessageEvent: update, messageStorage: { format,
      ...(delta ? { baseSeq: base!.seq, patches } : { snapshot: message }) } })
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
    const previous = this.previous.get(key)
    if (previous && BigInt(previous.seq) >= BigInt(event.seq)) return
    this.previous.set(key, { seq: event.seq, message: structuredClone(payload.message),
      depth: previous && previous.depth < snapshotInterval ? previous.depth + 1 : 0 })
  }

  private key(event: DurableEvent): string {
    const payload = isObject(event.payload) ? event.payload : {}
    return `${event.sessionId}:${event.turnId}:${String(payload.messageId ?? '')}`
  }
}

export function restoreStreamPayload(payload: JsonValue, previous: (seq: string) => JsonValue): JsonValue {
  if (!isObject(payload) || !isObject(payload.messageStorage) || payload.messageStorage.format !== format) return payload
  const { messageStorage: storage, ...rest } = payload
  let message: JsonValue
  if (Object.hasOwn(storage, 'snapshot')) message = storage.snapshot!
  else {
    if (typeof storage.baseSeq !== 'string' || !Array.isArray(storage.patches)) throw new Error('Invalid persisted message delta')
    const base = previous(storage.baseSeq)
    if (!isObject(base) || !isObject(base.message) || base.messageId !== payload.messageId) throw new Error('Missing persisted message delta base')
    message = applyMessagePatches(base.message, storage.patches as unknown as MessagePatch[])
  }
  if (!isObject(rest.assistantMessageEvent)) throw new Error('Invalid persisted stream event')
  return { ...rest, message, assistantMessageEvent: { ...rest.assistantMessageEvent, partial: message } }
}
