import type { EdenDatabase } from '@eden/store'
import type { SQLOutputValue } from 'node:sqlite'
import { napcatPermissionPreview } from './napcat-preview.ts'

function brief(value: unknown, limit = 180): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\b(password|token|secret|api[_-]?key)=\S+/gi, '$1=[隐藏]').slice(0, limit)
}

function permissionPreview(details: unknown): string {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return ''
  const value = details as Record<string, unknown>
  const napcat = napcatPermissionPreview(value)
  if (napcat) return napcat
  if (value.action === 'create_reminder' && value.input && typeof value.input === 'object' && !Array.isArray(value.input)) {
    const reminder = value.input as Record<string, unknown>
    const remindAt = typeof reminder.remindAt === 'number' && Number.isFinite(reminder.remindAt)
      && Math.abs(reminder.remindAt) <= 8.64e15
      ? new Date(reminder.remindAt).toISOString() : reminder.remindAt
    return `提醒: ${brief(reminder.title, 100)}；时间: ${brief(remindAt, 60)}`
  }
  for (const key of ['command', 'path', 'url', 'queries', 'query', 'action']) {
    const item = value[key]
    if (item !== undefined) return `${key}: ${brief(Array.isArray(item) ? item.join(', ') : item)}`
  }
  return ''
}

function resultSummary(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ''
  const value = result as Record<string, unknown>
  if (typeof value.exitCode === 'number') return `退出码 ${value.exitCode}`
  if (typeof value.path === 'string' && typeof value.bytes === 'number') return `${brief(value.path, 100)}，${value.bytes} 字节`
  for (const key of ['results', 'entries', 'items']) {
    if (Array.isArray(value[key])) return `${value[key].length} 项`
  }
  return ''
}

function eventUpdate(database: EdenDatabase, sessionId: string, turnId: string, event: Record<string, SQLOutputValue>) {
  const payload = JSON.parse(String(event.payload_json)) as Record<string, unknown>
  const seq = String(event.seq)
  if (event.kind === 'operation.started') {
    return ({ seq, kind: 'tool_start', name: brief(payload.name, 80) })
  } else if (event.kind === 'operation.completed') {
    const operation = database.connection.prepare('SELECT tool_name FROM tool_operations WHERE id=? AND session_id=?')
      .get(`${turnId}:${String(payload.callId ?? '')}`, sessionId)
    return ({ seq, kind: 'tool_end', name: brief(operation?.tool_name, 80),
      outcome: payload.outcome === 'completed' ? 'completed' : 'failed', summary: resultSummary(payload.result) })
  } else if (event.kind === 'permission.requested') {
    const permission = database.connection.prepare('SELECT state FROM permission_requests WHERE id=? AND session_id=?')
      .get(String(payload.id ?? ''), sessionId)
    if (permission?.state !== 'pending') return undefined
    return ({ seq, kind: 'approval', request_id: String(payload.id ?? ''),
      capability: brief(payload.capability, 80), resource: brief(payload.resource, 180),
      preview: permissionPreview(payload.details) })
  } else if (event.kind === 'permission.resolved') {
    return ({ seq, kind: 'approval_resolved', request_id: String(payload.requestId ?? ''),
      state: brief(payload.state, 30) })
  } else if (event.kind === 'qq.file_requested') {
    return ({ seq, kind: 'file_send', blob_id: String(payload.blobId ?? ''),
      filename: String(payload.filename ?? ''), byte_length: Number(payload.byteLength ?? 0) })
  }
}

export function privateTurnStatus(database: EdenDatabase, sessionId: string, turnId: string,
  row: { state?: SQLOutputValue; error?: SQLOutputValue }, afterSeq: string): unknown {
  const eventRows = database.connection.prepare(`SELECT CAST(seq AS TEXT) AS seq,kind,payload_json FROM events
    WHERE session_id=? AND turn_id=? AND seq>? AND kind IN
      ('operation.started','operation.completed','permission.requested','permission.resolved','qq.file_requested') ORDER BY seq LIMIT 100`)
    .all(sessionId, turnId, BigInt(afterSeq))
  const updates = eventRows.map(event => eventUpdate(database, sessionId, turnId, event))
    .filter(update => update !== undefined)
  const next_seq = eventRows.length ? String(eventRows[eventRows.length - 1]!.seq) : afterSeq
  const has_more = eventRows.length === 100
  const state = String(row.state)
  if (state !== 'completed') return { status: state, error: row.error == null ? null : String(row.error), updates, next_seq, has_more }
  const messages = database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=? AND turn_id=?
    AND kind='agent.message_end' ORDER BY seq DESC`).all(sessionId, turnId)
  for (const item of messages) {
    const payload = JSON.parse(String(item.payload_json)) as { message?: { role?: string; content?: string | { type?: string; text?: string }[] } }
    if (payload.message?.role !== 'assistant') continue
    const content = payload.message.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
    return { status: 'completed', text, updates, next_seq, has_more }
  }
  return { status: 'completed', text: '', updates, next_seq, has_more }
}
