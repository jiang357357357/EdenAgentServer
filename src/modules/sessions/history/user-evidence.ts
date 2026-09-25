import type { EdenDatabase } from '@eden/store'
import { SessionOwnership } from '../../accounts/index.ts'

const humanInput = `i.kind='prompt' AND i.state IN ('running','completed')
  AND EXISTS(SELECT 1 FROM session_classification c WHERE c.session_id=i.session_id
    AND c.purpose='user_chat' AND c.source_channel='app')
  AND json_extract(i.metadata_json,'$.job') IS NULL
  AND COALESCE(json_extract(i.metadata_json,'$.internalHandoff'),0)=0
  AND COALESCE(json_extract(i.metadata_json,'$.environment.sessionPurpose'),'')!='self_awake'
  AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.input_id=i.id)
  AND NOT EXISTS(SELECT 1 FROM subagent_threads s WHERE s.child_session_id=i.session_id)
  AND EXISTS(SELECT 1 FROM json_each(i.metadata_json,'$.participants') p
    WHERE CAST(COALESCE(json_extract(p.value,'$.characterId'),json_extract(p.value,'$.profile.character.id')) AS TEXT)=?)`
type Scope = { account: string; character: string }

/** Verify provenance; relevance is still a character judgment, never an authorization grant. */
export function verifyUserEvidence(database: EdenDatabase, scope: Scope,
  evidence: { sessionId: string; turnId: string; quote: string }, after: number) {
  const ownership = new SessionOwnership(database)
  ownership.assert(evidence.sessionId)
  if ((ownership.owner(evidence.sessionId) ?? '') !== scope.account) throw new Error('答复不属于当前账户')
  const row = database.connection.prepare(`SELECT i.text,i.created_at FROM inputs i
    WHERE i.session_id=? AND i.turn_id=? AND i.created_at>? AND ${humanInput}`)
    .get(evidence.sessionId, evidence.turnId, after, scope.character)
  if (!row || !evidence.quote.trim() || !String(row.text).includes(evidence.quote)) {
    throw new Error('恢复需要等待开始后、与当前角色交流的真实用户原话及会话标识')
  }
  return { source: 'user_message', ...evidence, occurredAt: Number(row.created_at) }
}

/** Dormant plans become available to background turns when there is new human context to review. */
export function hasNewUserContext(database: EdenDatabase, scope: Scope, after: number) {
  return Boolean(database.connection.prepare(`SELECT 1 FROM inputs i
    WHERE i.created_at>? AND ${humanInput}
    AND COALESCE((SELECT account_key FROM session_owners WHERE session_id=i.session_id),'')=? LIMIT 1`)
    .get(after, scope.character, scope.account))
}
export function isSelfAwakeInput(database: EdenDatabase, owner: { sessionId: string; turnId: string }) {
  return Boolean(database.connection.prepare(`SELECT 1 FROM inputs WHERE session_id=? AND turn_id=?
    AND (json_extract(metadata_json,'$.job.kind')='self_awake' OR json_extract(metadata_json,'$.environment.sessionPurpose')='self_awake')`)
    .get(owner.sessionId, owner.turnId))
}
