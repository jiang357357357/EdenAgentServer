import type { EdenDatabase } from '@eden/store'
import type { PermissionService } from '../permissions/index.ts'
import type { SessionRepository } from '../sessions/index.ts'

export interface QqPermissionInput {
  bot_qq: string
  contact_qq: string
  group_qq?: string | undefined
  request_id?: string | undefined
  decision: 'allow' | 'deny'
}

/** Core authenticates the administrator; the host binds approvals to this conversation. */
export function resolveQqPermission(database: EdenDatabase, repository: SessionRepository,
  permissions: PermissionService, input: QqPermissionInput) {
  const scope = input.group_qq
    ? { table: 'qq_group_sessions', where: 'q.bot_qq=? AND q.group_qq=?', target: input.group_qq }
    : { table: 'qq_channel_conversations', where: 'q.bot_qq=? AND q.contact_qq=?', target: input.contact_qq }
  const pending = database.connection.prepare(`SELECT DISTINCT p.id,p.session_id FROM permission_requests p
    JOIN ${scope.table} q ON q.session_id=p.session_id
    JOIN inputs i ON i.session_id=p.session_id AND i.turn_id=p.turn_id
    JOIN session_classification c ON c.session_id=p.session_id AND c.source_channel='qq'
    WHERE ${scope.where} AND p.state='pending' AND i.state='running'
    AND (? IS NULL OR p.id=?) ORDER BY p.created_at`).all(
      input.bot_qq, scope.target, input.request_id ?? null, input.request_id ?? null)
  for (const request of pending) repository.ownership.assert(String(request.session_id))
  if (pending.length === 0) return { resolved: false, reason: 'none' }
  if (pending.length > 1) return { resolved: false, reason: 'multiple' }
  permissions.resolve(String(pending[0]!.id), input.decision === 'allow')
  return { resolved: true, decision: input.decision }
}
