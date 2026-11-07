import type { EdenDatabase } from '@eden/store'
import { z } from 'zod'

const originSchema = z.object({ session_id: z.string(), bot_qq: z.string(), group_qq: z.string(), contact_qq: z.string() })

/** A shared room never has a default human operator. The running input supplies it. */
export function qqGroupOrigin(database: EdenDatabase, sessionId: string, turnId?: string) {
  const group = database.connection.prepare(`SELECT g.*,EXISTS(SELECT 1 FROM qq_shared_rooms r WHERE r.session_id=g.session_id) AS shared
    FROM qq_group_sessions g WHERE g.session_id=?`).get(sessionId)
  if (!group) return undefined
  if (!group.shared) return originSchema.parse({ session_id: sessionId,
    bot_qq: group.bot_qq, group_qq: group.group_qq, contact_qq: group.operator_qq })
  if (!turnId) throw new Error('Shared QQ tools require the executing turn identity')
  const row = database.connection.prepare(`SELECT q.operator_qq FROM qq_group_inputs q JOIN inputs i ON i.id=q.input_id
    JOIN sessions s ON s.id=i.session_id WHERE q.session_id=? AND q.turn_id=? AND i.state='running'
    AND (s.status='active' OR (s.status='closed' AND EXISTS(SELECT 1 FROM jobs j WHERE j.input_id=i.id
      AND j.kind IN ('memo.reminder','memo.reminder.redelivery') AND j.state IN ('running','dispatched'))))`)
    .get(sessionId, turnId)
  if (!row) throw new Error('Shared QQ turn identity is no longer active')
  return originSchema.parse({ session_id: sessionId, bot_qq: group.bot_qq, group_qq: group.group_qq, contact_qq: row.operator_qq })
}

export function qqSharedInput(database: EdenDatabase, inputId: string, bot: string, group: string, operator: string) {
  return database.connection.prepare(`SELECT i.session_id,i.turn_id,i.state,t.error FROM qq_group_inputs q
    JOIN inputs i ON i.id=q.input_id JOIN qq_group_sessions g ON g.session_id=q.session_id
    LEFT JOIN turns t ON t.id=i.turn_id WHERE q.input_id=? AND g.bot_qq=? AND g.group_qq=? AND q.operator_qq=?`)
    .get(inputId, bot, group, operator)
}

export function copySharedInput(database: EdenDatabase, sourceId: string, inputId: string, turnId: string): void {
  database.connection.prepare(`INSERT INTO qq_group_inputs
    SELECT ?,session_id,?,operator_qq,source_key,source_seq,origin_json FROM qq_group_inputs WHERE input_id=?`)
    .run(inputId, turnId, sourceId)
}
