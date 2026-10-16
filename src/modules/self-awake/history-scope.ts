import type { SessionRepository } from '../sessions/index.ts'

export interface SelfAwakeHistoryScope {
  kind: 'character' | 'session'
  sessionId: string
  origin: 'mon' | 'local'
  characterId?: string
  accountKey?: string
}

/** Identity belongs to the admitted input and executing actor, never to model arguments. */
export function selfAwakeHistoryScope(sessions: SessionRepository, sessionId: string, turnId: string,
  actorId?: string | number): SelfAwakeHistoryScope {
  sessions.readMetadata(sessionId)
  const database = sessions.database
  if (database.connection.prepare('SELECT 1 FROM qq_group_sessions WHERE session_id=?').get(sessionId))
    throw new Error('群会话不能读取个人自醒日记和计划')
  const fallback: SelfAwakeHistoryScope = { kind: 'session', sessionId, origin: sessions.origin }
  const row = database.connection.prepare("SELECT metadata_json FROM inputs WHERE session_id=? AND turn_id=? AND state='running'")
    .get(sessionId, turnId)
  if (!row) return fallback
  const characterId = historyCharacter(object(JSON.parse(String(row.metadata_json))), actorId)
  if (!characterId) return fallback
  const accountKey = sessions.ownership.owner(sessionId)
  if (sessions.origin === 'mon' && !accountKey) return fallback
  return { ...fallback, kind: 'character', characterId, ...(accountKey ? { accountKey } : {}) }
}

function historyCharacter(metadata: Record<string, unknown>, actorId?: string | number): string | undefined {
  const participants = Array.isArray(metadata.participants) ? metadata.participants.map(object) : []
  if (participants.length > 1 && actorId === undefined) throw new Error('多人会话读取自醒记录需要当前行动角色')
  const participant = actorId === undefined ? participants[0] : participants.find(value => String(value.assistantId) === String(actorId))
  if (actorId !== undefined && !participant) throw new Error('当前行动角色不属于本轮会话')
  if (!participant) return undefined
  const id = participant.characterId ?? object(object(participant.profile).character).id
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return undefined
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('当前角色身份无效')
  return String(id)
}

export function historyScopeView(scope: SelfAwakeHistoryScope) {
  return { kind: scope.kind, ...(scope.characterId ? { characterId: scope.characterId } : {}),
    coverage: scope.kind === 'character' ? 'owned_character_sessions' : 'current_session' }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
