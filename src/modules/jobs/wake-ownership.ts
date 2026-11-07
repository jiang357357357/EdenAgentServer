import type { EdenDatabase } from '@eden/store'
import type { JobSchedule } from '@eden/api'

/** Scheduling enforces the persisted owner even for callers outside the self-awake tools. */
export function normalizeWakeOwnership(database: EdenDatabase, input: JobSchedule): void {
  if (!['self_awake', 'connector.event'].includes(input.kind)) return
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {}
  const scope = database.connection.prepare(`SELECT r.scope_key,r.session_id FROM self_awake_role_members m
    JOIN self_awake_role_scopes r ON r.scope_key=m.scope_key WHERE m.session_id=?`).get(input.sessionId)
  if (scope && scope.session_id !== input.sessionId && input.kind === 'self_awake') throw new Error('旧后台范围已退役，请使用角色当前自醒时钟')
  if (payload.roleScope !== undefined && (scope ? payload.roleScope !== scope.scope_key : input.kind !== 'connector.event')) throw new Error('Self-awake role ownership mismatch')
  if (scope) input.payload = { ...payload, scheduleScope: 'role', roleScope: String(scope.scope_key) }
}
