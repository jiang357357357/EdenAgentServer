import type { EdenDatabase } from '@eden/store'
import { qqSharedMessageSchema } from '@eden/api'
import type { QqSharedContext, QqSharedMessage } from '@eden/api'
import { sharedGroupRecord } from '../../model-prompts/qq-shared-history.ts'

export class QqSharedRepository {
  constructor(private readonly database: EdenDatabase) {}

  room(bot: string, group: string): string | undefined {
    const row = this.database.connection.prepare('SELECT session_id FROM qq_shared_rooms WHERE bot_qq=? AND group_qq=?').get(bot, group)
    return row ? String(row.session_id) : undefined
  }

  bind(sessionId: string, bot: string, group: string): void {
    this.database.transaction(() => {
      this.database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)').run(sessionId, bot, group, '', 0, Date.now())
      this.database.connection.prepare('INSERT INTO qq_shared_rooms VALUES(?,?,?)').run(sessionId, bot, group)
    })
  }

  ingest(sessionId: string, messages: QqSharedMessage[]): number {
    return this.database.transaction(() => {
      for (const message of messages) {
        const old = this.database.connection.prepare('SELECT message_json FROM qq_group_history WHERE session_id=? AND source_key=?')
          .get(sessionId, message.source_key)
        if (old) {
          const prior = qqSharedMessageSchema.parse(JSON.parse(String(old.message_json)))
          if (prior.content !== message.content || prior.sender_qq !== message.sender_qq || prior.sequence !== message.sequence || prior.role !== message.role)
            throw new Error('QQ history source was reused with different message content')
          continue
        }
        this.database.connection.prepare('INSERT INTO qq_group_history VALUES(?,?,?,?)')
          .run(sessionId, message.source_key, message.sequence, JSON.stringify(message))
      }
      return Number(this.database.connection.prepare('SELECT COALESCE(MAX(source_seq),0) AS n FROM qq_group_history WHERE session_id=?').get(sessionId)?.n)
    })
  }

  admit(sessionId: string, input: { inputId: string; turnId: string }, context: QqSharedContext): void {
    if (!this.database.inTransaction) throw new Error('QQ input identity must commit with its input')
    this.database.connection.prepare('INSERT INTO qq_group_inputs VALUES(?,?,?,?,?,?,?)').run(
      input.inputId, sessionId, input.turnId, context.operator_qq, context.source_key, context.sequence, JSON.stringify(context))
  }

  previousAccepted(sessionId: string, previous: string | null): boolean {
    return previous === null || Boolean(this.database.connection.prepare('SELECT 1 FROM qq_group_inputs WHERE session_id=? AND source_key=?').get(sessionId, previous))
  }

  history(sessionId: string, through: number) {
    return this.database.connection.prepare(`SELECT h.message_json FROM qq_group_history h
      WHERE h.session_id=? AND h.source_seq<?
      AND NOT EXISTS(SELECT 1 FROM qq_group_inputs i WHERE i.session_id=h.session_id AND i.source_key=h.source_key)
      ORDER BY h.source_seq`).all(sessionId, through).flatMap(row => {
        const message = qqSharedMessageSchema.parse(JSON.parse(String(row.message_json)))
        if (message.kind === 'progress') return []
        if (message.reply_to_input && this.database.connection.prepare('SELECT 1 FROM qq_group_inputs WHERE session_id=? AND input_id=?')
          .get(sessionId, message.reply_to_input)) return []
        return [{ key: message.source_key, text: sharedGroupRecord(message),
          timestamp: Number.isNaN(Date.parse(message.timestamp)) ? new Date(0).toISOString() : message.timestamp }]
      })
  }
}
