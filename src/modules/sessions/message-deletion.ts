import type { DurableEvent } from '@eden/api'
import type { SessionRepository } from './session-repository.ts'
import { SessionContextDeletion } from './history/context-deletion.ts'

/** Chat and model-context deletion commit together; execution evidence remains separate. */
export class MessageDeletion {
  constructor(private readonly repository: SessionRepository) {}

  remove(sessionId: string, messageId: string) {
    const session = this.repository.read(sessionId)
    if (session.executionStatus !== 'idle') throw new Error('请等待当前回答结束后再删除。')
    const database = this.repository.database
    let event: DurableEvent | undefined
    database.transaction(() => {
      const row = database.connection.prepare(`SELECT turn_id,payload_json FROM events
        WHERE session_id=? AND kind='agent.message_end'
        AND COALESCE(json_extract(payload_json,'$.messageId'),json_extract(payload_json,'$.messageID'),id)=?
        ORDER BY seq DESC LIMIT 1`).get(sessionId, messageId)
      if (!row) throw new Error('这条回答不存在或尚未完成。')
      const payload = JSON.parse(String(row.payload_json)) as { message?: { role?: unknown } }
      if (payload?.message?.role !== 'assistant') throw new Error('只能删除已完成的智能体回答。')
      const deleted = database.connection.prepare(`SELECT 1 FROM events WHERE session_id=? AND kind='message.deleted'
        AND json_extract(payload_json,'$.messageId')=? LIMIT 1`).get(sessionId, messageId)
      if (!deleted) {
        database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), sessionId)
        event = this.repository.events.insert(sessionId, row.turn_id === null ? null : String(row.turn_id), 'message.deleted', { messageId, contextRemoved: true })
      }
      new SessionContextDeletion(database).persist(sessionId)
    })
    if (event) this.repository.events.publish(event)
    return { sessionId, messageId, deleted: true as const }
  }
}
