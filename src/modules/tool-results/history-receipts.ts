import { toJson } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { privateToolHistoryEntries } from './model-history.ts'

/** Caller has already checked session ownership. Raw operations remain the durable audit source. */
export function modelHistoryReceipts(database: EdenDatabase, sessionId: string, turnId?: string) {
  const rows = database.connection.prepare(`SELECT id,turn_id,tool_call_id,tool_name,revision,result_json,request_json FROM tool_operations
    WHERE session_id=? AND result_json IS NOT NULL AND (? IS NULL OR turn_id=?) ORDER BY created_at,id`)
    .all(sessionId, turnId ?? null, turnId ?? null)
  return rows.map(row => {
    const result = JSON.parse(String(row.result_json))
    const name = String(row.tool_name), revision = String(row.revision)
    const id = String(row.id), turnPrefix = `${row.turn_id}:`
    const callId = row.tool_call_id == null ? (id.startsWith(turnPrefix) ? id.slice(turnPrefix.length) : id) : String(row.tool_call_id)
    const source = revision.startsWith('skill:') ? 'skill' : name.startsWith('mcp__') ? 'mcp'
      : name.startsWith('plugin_') ? 'plugin' : revision.startsWith('eden.') ? 'builtin' : null
    return toJson({ modelInput: row.request_json === null ? {} : JSON.parse(String(row.request_json)),
      message: { role: 'toolResult', toolName: name, modelSource: source, toolCallId: callId,
        details: result } })
  })
}

export function modelAssistantText(database: EdenDatabase, sessionId: string, text: string, turnId?: string): string {
  const entries = privateToolHistoryEntries([{ message: { role: 'assistant', content: text } }], modelHistoryReceipts(database, sessionId, turnId))
  const wrapper = entries[0] as { message: { content: string } }
  return wrapper.message.content
}
