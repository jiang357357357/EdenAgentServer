import type { EdenDatabase } from '@eden/store'
import type { JsonValue } from '@eden/api'
import { DesktopError } from './contracts.ts'

export class DesktopOperations {
  constructor(private readonly database: EdenDatabase) {
    database.connection.prepare("UPDATE desktop_operations SET state='unknown',error='Host restarted before desktop result confirmation',updated_at=? WHERE state='running'").run(Date.now())
  }
  begin(input: { id: string; sessionId: string; turnId: string; actor: string; action: string; request: JsonValue }) {
    const db = this.database.connection
    if (db.prepare('SELECT 1 FROM desktop_operations WHERE id=?').get(input.id))
      throw new DesktopError('该桌面操作已登记，不能重放；请先观察实际结果', 'DUPLICATE_DESKTOP_OPERATION', 'unknown')
    db.prepare("INSERT INTO desktop_operations VALUES(?,?,?,?,?,'running',?,NULL,NULL,?,?)")
      .run(input.id, input.sessionId, input.turnId, input.actor, input.action, JSON.stringify(input.request), Date.now(), Date.now())
  }
  finish(id: string, state: string, result: JsonValue | null, error: string | null = null) {
    this.database.connection.prepare("UPDATE desktop_operations SET state=?,result_json=?,error=?,updated_at=? WHERE id=? AND state='running'")
      .run(state, result === null ? null : JSON.stringify(result), error, Date.now(), id)
  }
}
