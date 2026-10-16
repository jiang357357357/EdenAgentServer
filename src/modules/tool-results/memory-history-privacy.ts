import { credentialValues, redactCredentialJson } from '@eden/api'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'

const tools = new Set(['remember_memory', 'update_memory', 'forget_memory', 'search_memories'])
const record = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Only memory tool payloads are classified; other tool outputs retain their business content. */
export function privateMemoryPayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(privateMemoryPayload)
  const fields = record(value)
  if (!fields) return value
  const memory = containsMemoryTool(fields)
  return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key,
    memory && ['args', 'arguments', 'input', 'content', 'details', 'result', 'delta', 'partialJson', '_partialJson'].includes(key)
      ? redactCredentialJson(item) : privateMemoryPayload(item)]))
}

function containsMemoryTool(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsMemoryTool)
  const fields = record(value)
  return Boolean(fields && (tools.has(String(fields.toolName ?? fields.name)) || Object.values(fields).some(containsMemoryTool)))
}

export function privateMemoryCheckpoint(checkpoint: RuntimeCheckpoint, known: readonly string[] = []): RuntimeCheckpoint {
  const hidden = new Set(known)
  const collect = (value: JsonValue, memory = false): void => {
    if (typeof value === 'string') {
      if (memory) {
        credentialValues(value).forEach(secret => hidden.add(secret))
        if (/^[\[{]/.test(value.trim())) try { collect(JSON.parse(value) as JsonValue, true) } catch { /* Text result. */ }
      }
      return
    }
    if (Array.isArray(value)) { value.forEach(item => collect(item, memory)); return }
    const fields = record(value)
    if (fields) Object.values(fields).forEach(item => collect(item, memory || tools.has(String(fields.toolName ?? fields.name))))
  }
  checkpoint.entries.forEach(entry => collect(entry))
  const entries = checkpoint.entries.map(entry => {
    const value = record(privateMemoryPayload(entry))
    if (!value) return entry
    const message = record(value.message)
    return { ...value,
      ...(message ? { message: { ...message,
        ...(message.content === undefined ? {} : { content: redactCredentialJson(message.content, [...hidden], false) }),
        ...(message.details === undefined ? {} : { details: redactCredentialJson(message.details, [...hidden], false) }) } } : {}),
      ...(typeof value.summary === 'string' ? { summary: redactCredentialJson(value.summary, [...hidden], false) } : {}),
      ...(value.retainedTail ? { retainedTail: redactCredentialJson(value.retainedTail, [...hidden], false) } : {}) }
  })
  return { ...checkpoint, entries }
}
