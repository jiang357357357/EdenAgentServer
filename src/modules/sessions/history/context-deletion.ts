import { isDeepStrictEqual } from 'node:util'
import { runtimeCheckpointSchema } from '@eden/api'
import type { JsonValue, RuntimeCheckpoint } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { removeCheckpointMessages } from '@eden/runtime-pi'
import { projectActorTurnHistory } from '../../../model-prompts/actors.ts'
import { publicMessage } from './public-message.ts'
import { privateQqHistoryEntries } from '../../tool-results/index.ts'

interface DeletedMessage {
  key: string
  entryId?: string
  actorId?: string
  message: Record<string, JsonValue>
  variants: JsonValue[]
  publicMessage: Record<string, JsonValue>
  deletedAt: number
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function matchesMessage(message: Record<string, JsonValue>, target: DeletedMessage, entryId?: string): boolean {
  if (message.role !== 'assistant') return false
  if (entryId && target.entryId) return target.entryId === entryId
  return message.timestamp === target.message.timestamp && isDeepStrictEqual(message.content, target.message.content)
}

function matchesPublicText(message: Record<string, JsonValue>, original: JsonValue): boolean {
  const text = message.text, originalText = object(publicMessage(original)).text
  return typeof text === 'string' && typeof originalText === 'string'
    && (originalText === text || (message.truncated === true && originalText.endsWith(text)))
}

function deletedHistory(value: JsonValue, targets: DeletedMessage[]): boolean {
  const wrapper = object(value), message = object(wrapper.message ?? value)
  if (targets.some(target => target.variants.some(variant => matchesMessage(message, { ...target, message: object(variant) })))) return true
  const text = message.text
  if (message.role !== 'assistant' || typeof text !== 'string' || !text) return false
  return targets.some(target => target.publicMessage.assistantID === wrapper.assistantID
    && target.variants.some(variant => matchesPublicText(message, variant)))
}

/** Projection and eager rewrites share the durable deletion ledger, scoped to one session. */
export class SessionContextDeletion {
  constructor(private readonly database: EdenDatabase) {}

  project(snapshot: RuntimeCheckpoint, actorId?: string): RuntimeCheckpoint {
    const targets = this.targets(snapshot.sessionId)
    if (!targets.length) return snapshot
    const own = targets.filter(target => target.actorId === actorId)
    const projectHistory = (history: JsonValue[]) => history.filter(value => !deletedHistory(value, targets))
    return removeCheckpointMessages(snapshot, {
      matchesMessage: (message, entryId) => own.some(target => target.entryId !== undefined && matchesMessage(object(message), target, entryId)),
      legacyMessages: own.filter(target => target.entryId === undefined).map(target => ({ key: target.key, messages: target.variants })),
      projectHistory,
      ...(actorId === undefined ? {} : { projectUserContent: (content: string) => projectActorTurnHistory(content, projectHistory) }),
      invalidateSummariesBefore: Math.max(...targets.map(target => target.deletedAt)),
    })
  }

  persist(sessionId: string): void {
    if (!this.database.inTransaction) throw new Error('Context deletion must share the message deletion transaction')
    const db = this.database.connection
    const main = db.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(sessionId)
    if (main) this.update(sessionId, String(main.checkpoint_json))
    for (const actor of db.prepare('SELECT assistant_id,checkpoint_json FROM actor_checkpoints WHERE session_id=?').all(sessionId)) {
      this.update(sessionId, String(actor.checkpoint_json), String(actor.assistant_id))
    }
  }

  private update(sessionId: string, serialized: string, actorId?: string): void {
    const checkpoint = runtimeCheckpointSchema.parse(JSON.parse(serialized))
    if (checkpoint.sessionId !== sessionId) throw new Error('Deleted context checkpoint session mismatch')
    const projected = this.project(checkpoint, actorId)
    if (projected === checkpoint) return
    if (actorId === undefined) this.database.connection.prepare('UPDATE runtime_checkpoints SET checkpoint_json=?,updated_at=? WHERE session_id=?')
      .run(JSON.stringify(projected), Date.now(), sessionId)
    else this.database.connection.prepare('UPDATE actor_checkpoints SET checkpoint_json=?,updated_at=? WHERE session_id=? AND assistant_id=?')
      .run(JSON.stringify(projected), Date.now(), sessionId, actorId)
  }

  private targets(sessionId: string): DeletedMessage[] {
    const rows = this.database.connection.prepare(`SELECT original.id,original.payload_json,removed.created_at FROM events removed
      JOIN events original ON original.session_id=removed.session_id AND original.kind='agent.message_end'
      AND COALESCE(json_extract(original.payload_json,'$.messageId'),json_extract(original.payload_json,'$.messageID'),original.id)=json_extract(removed.payload_json,'$.messageId')
      WHERE removed.session_id=? AND removed.kind='message.deleted' ORDER BY removed.seq`).all(sessionId)
    const targets = rows.map(row => {
      const payload = object(JSON.parse(String(row.payload_json))), actorId = object(payload.actor).assistantID
      const message = object(payload.message)
      if (message.role !== 'assistant') throw new Error('Deleted context must reference an assistant message')
      return { key: String(row.id), message, variants: [message] as JsonValue[], publicMessage: object(publicMessage(payload)), deletedAt: Number(row.created_at),
        ...(typeof payload.contextEntryId === 'string' ? { entryId: payload.contextEntryId } : {}),
        ...(typeof actorId === 'string' || typeof actorId === 'number' ? { actorId: String(actorId) } : {}) }
    })
    const legacy = targets.filter(target => target.entryId === undefined)
    if (legacy.length) {
      const receipts = this.database.connection.prepare(`SELECT payload_json FROM events WHERE session_id=?
        AND kind IN ('agent.message_end','actor.runtime.message_end') AND json_extract(payload_json,'$.message.role')='toolResult'`).all(sessionId)
        .map(row => ({ message: object(JSON.parse(String(row.payload_json))).message ?? null }))
      const projected = privateQqHistoryEntries([...receipts, ...legacy.map(target => ({ message: target.message }))]).slice(receipts.length)
      legacy.forEach((target, index) => target.variants.push(object(projected[index]).message ?? target.message))
    }
    return targets
  }
}
