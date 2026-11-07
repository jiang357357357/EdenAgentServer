import { qqSharedContextSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { QqSharedRepository } from './shared-repository.ts'
import { sharedGroupInput } from '../../model-prompts/qq-shared-history.ts'

export function sharedGroupRuntime(database: EdenDatabase,
  input: { id: string; sessionId: string; turnId: string; text: string; metadata?: JsonValue }, attachments: string) {
  const metadata = input.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const source = metadata.channelContext
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.schema_version !== 'qq-group-shared.v1') {
    if (!metadata.job) return undefined
    const origin = database.connection.prepare('SELECT origin_json FROM qq_group_inputs WHERE input_id=? AND session_id=? AND turn_id=?')
      .get(input.id, input.sessionId, input.turnId)
    if (!origin) return undefined
    const creator = qqSharedContextSchema.parse(JSON.parse(String(origin.origin_json)))
    return { text: sharedGroupInput({ ...creator, quote: undefined }, input.text, attachments), history: [] }
  }
  const context = qqSharedContextSchema.parse(source)
  const binding = database.connection.prepare('SELECT operator_qq,source_key FROM qq_group_inputs WHERE input_id=? AND session_id=? AND turn_id=?')
    .get(input.id, input.sessionId, input.turnId)
  if (!binding || binding.operator_qq !== context.operator_qq || binding.source_key !== context.source_key)
    throw new Error('Shared group runtime identity does not match the admitted input')
  const notices = database.connection.prepare("SELECT CAST(seq AS TEXT) AS seq,created_at,payload_json FROM events WHERE session_id=? AND kind='qq.role.changed' ORDER BY seq")
    .all(input.sessionId).map(row => ({ key: `role:${String(row.seq)}`, timestamp: new Date(Number(row.created_at)).toISOString(),
      text: String((JSON.parse(String(row.payload_json)) as { text: string }).text) }))
  return { text: sharedGroupInput(context, input.text, attachments), history: [...new QqSharedRepository(database).history(input.sessionId, context.sequence), ...notices] }
}
