import { jsonSnapshot } from '@eden/api'
import type { JsonValue } from '@eden/api'
import { applyMessagePatches, isObject, messagePatches } from './message-delta.ts'

/** Size heuristic never serializes the cumulative text just to choose a delta. */
function weight(value: JsonValue): number {
  if (typeof value === 'string') return value.length + 2
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + weight(item) + 1, 2)
  if (isObject(value)) return Object.entries(value).reduce((total, [key, item]) => total + key.length + weight(item) + 4, 2)
  return 16
}

export function storeMessage(value: JsonValue, previous?: { seq: string; value: JsonValue }): Record<string, JsonValue> {
  if (!previous) return { snapshot: value }
  const patches = jsonSnapshot(messagePatches(previous.value, value))
  return weight(patches) < weight(value) ? { baseSeq: previous.seq, patches } : { snapshot: value }
}

export function storePartial(message: JsonValue, partial: JsonValue, previous?: { seq: string; value: JsonValue }): Record<string, JsonValue> {
  const fromMessage = jsonSnapshot(messagePatches(message, partial))
  const fromPrevious = storeMessage(partial, previous)
  const messageEncoding = { fromMessage }
  return weight(messageEncoding) <= weight(fromPrevious) ? messageEncoding : fromPrevious
}

export function restoreMessage(storage: Record<string, JsonValue>, base: () => JsonValue): JsonValue {
  if (Object.hasOwn(storage, 'snapshot')) return storage.snapshot!
  if (typeof storage.baseSeq !== 'string' || !Array.isArray(storage.patches)) throw new Error('Invalid persisted message delta')
  return applyMessagePatches(base(), storage.patches as unknown as import('./message-delta.ts').MessagePatch[])
}

export function restorePartial(storage: JsonValue, message: JsonValue, base: () => JsonValue): JsonValue {
  if (!isObject(storage)) throw new Error('Invalid persisted partial delta')
  if (Array.isArray(storage.fromMessage)) return applyMessagePatches(message, storage.fromMessage as unknown as import('./message-delta.ts').MessagePatch[])
  return restoreMessage(storage, base)
}
