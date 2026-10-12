import { createHash } from 'node:crypto'
import type { JsonValue } from '@eden/api'
import type { SessionRepository } from '../sessions/index.ts'
import { isQqReference } from '../tool-results/index.ts'
import type { NapcatSessionTarget } from './napcat-target.ts'
import { RuntimePersistenceError } from '@eden/runtime-pi'

export class QqReferenceRepository {
  constructor(private readonly sessions: SessionRepository) {}

  transaction<T>(work: () => T): T {
    try { return this.sessions.database.transaction(work) }
    catch (error) { throw new RuntimePersistenceError('QQ 业务引用保存失败，操作不得自动重发', error) }
  }

  private scope(target: NapcatSessionTarget): string {
    this.sessions.read(target.sessionId)
    // Do not persist credentials. Unowned compatibility sessions bind to the credential fingerprint.
    return createHash('sha256').update(JSON.stringify([target.baseUrl, target.resource,
      this.sessions.ownership.owner(target.sessionId) ?? target.identity?.userId ?? target.token])).digest('hex')
  }

  remember(target: NapcatSessionTarget, kind: string, value: string | number): string {
    const scope = this.scope(target), serialized = JSON.stringify(value), db = this.sessions.database.connection
    db.prepare('INSERT OR IGNORE INTO qq_action_references(session_id,scope,kind,value_json,created_at) VALUES(?,?,?,?,?)')
      .run(target.sessionId, scope, kind, serialized, Date.now())
    const row = db.prepare('SELECT id FROM qq_action_references WHERE session_id=? AND scope=? AND kind=? AND value_json=?')
      .get(target.sessionId, scope, kind, serialized)
    if (!row) throw new Error('QQ reference could not be persisted')
    return `qqref:${kind}:${row.id}`
  }

  known(target: NapcatSessionTarget): Map<string, string> {
    const rows = this.sessions.database.connection.prepare('SELECT id,kind,value_json FROM qq_action_references WHERE session_id=? AND scope=?')
      .all(target.sessionId, this.scope(target))
    return new Map(rows.map(row => [String(JSON.parse(String(row.value_json))), `qqref:${row.kind}:${row.id}`]))
  }

  resolve(target: NapcatSessionTarget, kind: string, reference: unknown): JsonValue {
    if (!isQqReference(reference)) throw new Error('QQ 操作需要工具返回的业务引用；不能填写原始平台标识')
    const [, suppliedKind, id] = reference.split(':')
    if (suppliedKind !== kind) throw new Error('QQ 业务引用类型不匹配')
    const row = this.sessions.database.connection.prepare('SELECT value_json FROM qq_action_references WHERE id=? AND session_id=? AND scope=? AND kind=?')
      .get(id!, target.sessionId, this.scope(target), suppliedKind!)
    if (!row) throw new Error('QQ 业务引用不属于当前会话、账号或机器人，请重新查询目标')
    return JSON.parse(String(row.value_json)) as JsonValue
  }
}
