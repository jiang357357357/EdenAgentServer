import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { qqModelResult } from './qq-result-privacy.ts'

const qqTools = new Set(['list_qq_capabilities', 'list_qq_events', 'read_qq_action', 'execute_qq_action',
  'send_qq_message', 'send_qq_file', 'read_qq_messages'])
const record = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Compatibility entry point: history now removes metadata, without hiding business identifiers. */
export function privateQqCheckpoint(checkpoint: RuntimeCheckpoint): RuntimeCheckpoint {
  return { ...checkpoint, entries: privateQqHistoryEntries(checkpoint.entries) }
}

export function privateQqHistoryEntries(history: JsonValue[]): JsonValue[] {
  return history.map(entry => {
    const value = record(entry), message = record(value?.message)
    if (!value || message?.role !== 'toolResult' || typeof message.toolName !== 'string'
      || !qqTools.has(message.toolName.replace(/^eden_/, ''))) return entry
    const content = Array.isArray(message.content) ? message.content.map(block => {
      const part = record(block)
      if (part?.type !== 'text' || typeof part.text !== 'string') return block
      let parsed: JsonValue
      try { parsed = JSON.parse(part.text) as JsonValue } catch { return block }
      return { ...part, text: JSON.stringify(qqModelResult(parsed)) }
    }) : message.content
    return { ...value, message: { ...message, ...(content === undefined ? {} : { content }),
      ...(message.details === undefined ? {} : { details: qqModelResult(message.details) }) } }
  })
}
