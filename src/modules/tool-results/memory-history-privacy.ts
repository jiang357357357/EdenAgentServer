import { credentialValues, isRuntimeProtocolField, isSignedThinking, redactCredentialJson } from '@eden/api'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { mapHistoryContent } from '@eden/runtime-pi'
import { mapModelHistoryText } from './model-history-text.ts'

const tools = new Set(['remember_memory', 'update_memory', 'forget_memory', 'search_memories'])
const record = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Only memory tool payloads are classified; other tool outputs retain their business content. */
export function privateMemoryPayload(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(privateMemoryPayload)
  const fields = record(value)
  if (!fields) return value
  if (fields.type === 'custom_message' && typeof fields.content === 'string')
    return { ...fields, content: mapHistoryContent(fields.content, privateMemoryPayload) }
  const memory = containsMemoryTool(fields)
  return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key,
    memory && ['args', 'arguments', 'input', 'content', 'details', 'result', 'delta', 'partialJson', '_partialJson'].includes(key)
      ? redactCredentialJson(item, [], true, mapModelHistoryText) : privateMemoryPayload(item)]))
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
    if (fields?.type === 'custom_message' && typeof fields.content === 'string')
      mapHistoryContent(fields.content, item => { collect(item); return item })
    if (fields && !isSignedThinking(fields)) Object.entries(fields).forEach(([key, item]) => {
      if (!isRuntimeProtocolField(key, fields)) collect(item, memory || tools.has(String(fields.toolName ?? fields.name)))
    })
  }
  checkpoint.entries.forEach(entry => collect(entry))
  const redact = (value: JsonValue) => redactCredentialJson(value, [...hidden], false, mapModelHistoryText)
  const entries = checkpoint.entries.map(entry => {
    const value = record(privateMemoryPayload(entry))
    if (!value) return entry
    const message = record(value.message)
    return { ...value,
      ...(message ? { message: { ...message,
        ...(message.content === undefined ? {} : { content: redact(message.content) }),
        ...(message.details === undefined ? {} : { details: redact(message.details) }) } } : {}),
      ...(value.content !== undefined && value.type === 'custom_message' ? { content: redact(value.content) } : {}),
      ...(typeof value.summary === 'string' ? { summary: redact(value.summary) } : {}),
      ...(value.retainedTail ? { retainedTail: redact(value.retainedTail) } : {}) }
  })
  return { ...checkpoint, entries }
}
