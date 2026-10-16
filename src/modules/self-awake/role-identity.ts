import { toJson, type JsonValue } from '@eden/api'
import { SessionOwnership } from '../accounts/index.ts'
import type { SessionRepository } from '../sessions/index.ts'

export interface WakeRoleIdentity {
  key: string
  accountKey: string
  characterId: string
  author: JsonValue
}

/** Tool callers use the admitted roster. The model never supplies scheduling ownership. */
export function wakeRoleIdentity(sessions: SessionRepository, sessionId: string, turnId?: string, actorId?: string | number): WakeRoleIdentity | undefined {
  const session = sessions.read(sessionId), db = sessions.database.connection
  if (db.prepare('SELECT 1 FROM qq_group_sessions WHERE session_id=?').get(sessionId)) throw new Error('群会话不能安排个人角色自醒，请使用备忘提醒')
  const input = turnId ? db.prepare("SELECT metadata_json FROM inputs WHERE session_id=? AND turn_id=? AND state='running'").get(sessionId, turnId) : undefined
  const roster = input ? object(JSON.parse(String(input.metadata_json))).participants : session.participants
  const participants = Array.isArray(roster) ? roster.map(object) : []
  if (participants.length > 1 && actorId === undefined) throw new Error('安排角色自醒需要当前行动角色')
  const author = actorId === undefined ? participants[0] : participants.find(value => String(value.assistantId) === String(actorId))
  if (actorId !== undefined && !author) throw new Error('当前行动角色不属于本轮会话')
  const accountKey = new SessionOwnership(sessions.database).owner(sessionId) ?? ''
  return wakeRoleFromAuthor(sessions.origin, accountKey, toJson(author ?? {}))
}

export function wakeRoleFromAuthor(origin: 'mon' | 'local', accountKey: string, author: JsonValue): WakeRoleIdentity | undefined {
  const value = object(author)
  const id = value.characterId ?? object(object(value.profile).character).id
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return undefined
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('当前角色身份无效')
  if (origin === 'mon' && !accountKey) throw new Error('角色自醒缺少已核对的账号归属')
  return { key: JSON.stringify([origin, accountKey, String(id)]), accountKey, characterId: String(id), author }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
