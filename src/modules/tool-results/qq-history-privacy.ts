import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { qqIdentifierHidden } from '../../model-prompts/qq-results.ts'
import { isQqReference, qqIdentifierKind, qqTraceKeys } from './qq-identifiers.ts'
import { qqModelResult } from './qq-result-privacy.ts'

const qqTools = new Set(['list_qq_capabilities', 'list_qq_events', 'read_qq_action', 'execute_qq_action',
  'send_qq_message', 'send_qq_file', 'read_qq_messages'])
const record = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Project a copy for runtime restoration; persisted audit history and protocol entry IDs are unchanged. */
export function privateQqCheckpoint(checkpoint: RuntimeCheckpoint): RuntimeCheckpoint {
  const entries = privateQqHistoryEntries(checkpoint.entries)
  return entries === checkpoint.entries ? checkpoint : { ...checkpoint, entries }
}

/** Apply the same projection to legacy event messages used for context identity matching. */
export function privateQqHistoryEntries(history: JsonValue[]): JsonValue[] {
  const hidden = new Set<string>()
  let hasQq = false
  const collectIdentifier = (value: JsonValue): void => {
    if (Array.isArray(value)) { value.forEach(collectIdentifier); return }
    if ((typeof value === 'string' || typeof value === 'number') && String(value) && !isQqReference(value)) hidden.add(String(value))
  }
  const collect = (value: JsonValue, segment?: string): void => {
    if (Array.isArray(value)) { value.forEach(item => collect(item, segment)); return }
    const fields = record(value)
    if (!fields) return
    const type = typeof fields.type === 'string' ? fields.type : segment
    for (const [key, item] of Object.entries(fields)) {
      if (key === 'parameters' || key === 'model_view') continue
      if (qqIdentifierKind(key, type) || qqTraceKeys.has(key)) collectIdentifier(item)
      else collect(item, key === 'resource_ids' ? 'resources' : type)
    }
  }
  const entries = history.map(entry => {
    const value = record(entry), message = record(value?.message)
    if (!value || message?.role !== 'toolResult' || !qqTools.has(String(message.toolName))) return entry
    hasQq = true
    if (message.details) collect(message.details)
    const content = Array.isArray(message.content) ? message.content.map(block => {
      const part = record(block)
      if (part?.type !== 'text' || typeof part.text !== 'string') return block
      let parsed: JsonValue
      try { parsed = JSON.parse(part.text) as JsonValue } catch { return block }
      collect(parsed)
      return { ...part, text: JSON.stringify(qqModelResult(parsed)) }
    }) : message.content
    return { ...value, message: { ...message, ...(content === undefined ? {} : { content }),
      ...(message.details === undefined ? {} : { details: qqModelResult(message.details) }) } }
  })
  if (!hasQq) return history
  const escaped = [...hidden].sort((a, b) => b.length - a.length).map(raw => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = escaped.length ? new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join('|')})(?![A-Za-z0-9])`, 'g') : undefined
  const redact = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') {
      return pattern ? value.replace(pattern, qqIdentifierHidden) : value
    }
    if (Array.isArray(value)) return value.map(redact)
    const fields = record(value)
    return fields ? Object.fromEntries(Object.entries(fields).map(([key, item]) =>
      [key, fields.type === 'toolCall' && key === 'id' ? item : redact(item)])) : value
  }
  return entries.map(entry => {
    const value = record(entry)
    if (!value) return entry
    // Session-tree linkage is an SDK fact, not a QQ platform identifier.
    const message = record(value.message)
    return { ...value, ...(message ? { message: { ...message,
      ...(message.content === undefined ? {} : { content: redact(message.content) }),
      ...(message.details === undefined ? {} : { details: redact(message.details) }) } } : {}),
      ...(typeof value.summary === 'string' ? { summary: redact(value.summary) } : {}),
      ...(value.retainedTail ? { retainedTail: redact(value.retainedTail) } : {}) }
  })
}
