import type { DurableEvent } from '@eden/api'
import type { SessionRepository } from './session-repository.ts'
import { SessionContextDeletion } from './history/context-deletion.ts'
import { randomUUID } from 'node:crypto'
import { replyGroup, replyText } from './history/reply-group.ts'

/** Chat and model-context deletion commit together; execution evidence remains separate. */
export class MessageDeletion {
  constructor(private readonly repository: SessionRepository) {}

  readReply(sessionId: string, messageId: string) {
    this.repository.read(sessionId)
    const messageIds = replyGroup(this.repository.database, sessionId, messageId).map(row => row.messageId)
    return { sessionId, messageId, messageIds, text: replyText(this.repository.database, sessionId, messageIds) }
  }

  remove(sessionId: string, messageId: string, scope: 'message' | 'reply' = 'message') {
    const session = this.repository.read(sessionId)
    if (session.executionStatus !== 'idle') throw new Error('请等待当前回答结束后再删除。')
    const database = this.repository.database
    const events: DurableEvent[] = []
    let messageIds = [messageId]
    database.transaction(() => {
      const row = database.connection.prepare(`SELECT turn_id,kind,payload_json FROM events
        WHERE session_id=? AND kind IN ('agent.message_end','character.sticker.sent')
        AND COALESCE(json_extract(payload_json,'$.messageId'),json_extract(payload_json,'$.messageID'),id)=?
        ORDER BY seq DESC LIMIT 1`).get(sessionId, messageId)
      if (!row) throw new Error('这条回答不存在或尚未完成。')
      const payload = JSON.parse(String(row.payload_json)) as { message?: { role?: unknown } }
      if (row.kind !== 'character.sticker.sent' && payload?.message?.role !== 'assistant') throw new Error('只能删除已完成的智能体回答。')
      const deleted = database.connection.prepare(`SELECT 1 FROM events WHERE session_id=? AND kind='message.deleted'
        AND json_extract(payload_json,'$.messageId')=? LIMIT 1`).get(sessionId, messageId)
      if (scope === 'reply') messageIds = deleted ? this.deletedReply(sessionId, messageId)
        : replyGroup(database, sessionId, messageId).map(member => member.messageId)
      if (!deleted) {
        database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(Date.now(), sessionId)
        const replyGroupId = scope === 'reply' ? randomUUID() : undefined
        for (const id of messageIds) events.push(this.repository.events.insert(sessionId, row.turn_id === null ? null : String(row.turn_id),
          'message.deleted', { messageId: id, contextRemoved: true, ...(replyGroupId ? { replyGroupId } : {}) }))
      }
      new SessionContextDeletion(database).persist(sessionId)
    })
    for (const event of events) this.repository.events.publish(event)
    return { sessionId, messageId, deleted: true as const, ...(scope === 'reply' ? { messageIds } : {}) }
  }

  private deletedReply(sessionId: string, messageId: string): string[] {
    const rows = this.repository.database.connection.prepare(`SELECT json_extract(payload_json,'$.messageId') AS messageId FROM events
      WHERE session_id=? AND kind='message.deleted' AND json_extract(payload_json,'$.replyGroupId')=(
        SELECT json_extract(payload_json,'$.replyGroupId') FROM events WHERE session_id=? AND kind='message.deleted'
        AND json_extract(payload_json,'$.messageId')=? ORDER BY seq DESC LIMIT 1) ORDER BY seq`).all(sessionId, sessionId, messageId)
    return rows.length ? rows.map(row => String(row.messageId)) : [messageId]
  }
}
