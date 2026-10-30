import type { EdenDatabase } from '@eden/store'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import { validCheckpointImage } from '@eden/runtime-pi'

const object = (value: JsonValue | undefined) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const key = (message: Record<string, JsonValue>) => JSON.stringify([message.toolName, message.toolCallId])

function damagedCalls(checkpoint: RuntimeCheckpoint): Map<string, { name: string; call: string }> {
  const calls = new Map<string, { name: string; call: string }>()
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    const fields = object(value)
    if (!fields) return
    if (fields.role === 'toolResult' && typeof fields.toolName === 'string' && typeof fields.toolCallId === 'string'
      && Array.isArray(fields.content) && fields.content.some(block => object(block)?.type === 'image' && !validCheckpointImage(block)))
      calls.set(key(fields), { name: fields.toolName, call: fields.toolCallId })
    if (fields.message) visit(fields.message)
    if (fields.retainedTail) visit(fields.retainedTail)
  }
  checkpoint.entries.forEach(visit)
  return calls
}

/** Older versions may retain the original image in an SDK event without an operation row. */
export function checkpointImageReceipts(database: EdenDatabase, snapshot: RuntimeCheckpoint, receipts: JsonValue[]): JsonValue[] {
  const needed = damagedCalls(snapshot)
  if (!needed.size) return []
  const selected = receipts.filter(receipt => {
    const message = object(object(receipt)?.message)
    return message && needed.has(key(message))
  })
  for (const receipt of selected) needed.delete(key(object(object(receipt)?.message)!))
  const statement = database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=?
    AND kind IN ('agent.tool_execution_end','actor.runtime.tool_execution_end')
    AND json_extract(payload_json,'$.toolCallId')=? ORDER BY seq`)
  for (const { name, call } of needed.values()) {
    for (const row of statement.all(snapshot.sessionId, call)) {
      const event = object(JSON.parse(String(row.payload_json)) as JsonValue)
      if (event?.toolName === name && event.result !== undefined) selected.push({ message: {
        role: 'toolResult', toolName: name, toolCallId: call, details: event.result } })
    }
  }
  return selected
}
