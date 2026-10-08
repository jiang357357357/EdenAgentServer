import type { EdenDatabase } from '@eden/store'
import { SessionOwnership } from '../accounts/index.ts'
import { seedSessionWorkspace } from './workspace-default-recovery.ts'

/** Each row owns a session's selection; account settings only seed a previously unseen session. */
export class SessionWorkspaceRepository {
  constructor(private readonly database: EdenDatabase, readonly sessionId: string) {}

  assert(): void {
    new SessionOwnership(this.database).assert(this.sessionId)
    if (!this.database.connection.prepare("SELECT 1 FROM sessions WHERE id=? AND status!='deleted'").get(this.sessionId))
      throw new Error('Session not found')
  }

  read(key: string): string | undefined {
    this.assert()
    this.initialize()
    const row = this.database.connection.prepare('SELECT settings_json FROM session_workspaces WHERE session_id=?').get(this.sessionId)!
    const settings = JSON.parse(String(row.settings_json)) as Record<string, unknown>
    return Object.hasOwn(settings, key) ? JSON.stringify(settings[key]) : undefined
  }

  write(key: string, value: unknown): void {
    this.assert()
    this.initialize()
    const row = this.database.connection.prepare('SELECT settings_json FROM session_workspaces WHERE session_id=?').get(this.sessionId)!
    const settings = JSON.parse(String(row.settings_json)) as Record<string, unknown>
    if (JSON.stringify(settings[key]) === JSON.stringify(value)) return
    settings[key] = value
    this.database.connection.prepare('UPDATE session_workspaces SET settings_json=?,revision=revision+1,updated_at=? WHERE session_id=?')
      .run(JSON.stringify(settings), Date.now(), this.sessionId)
  }

  revision(): string {
    this.assert()
    this.initialize()
    const statement = this.database.connection.prepare('SELECT revision FROM session_workspaces WHERE session_id=?')
    statement.setReadBigInts(true)
    return String(statement.get(this.sessionId)!.revision)
  }

  inherit(parentSessionId: string): void {
    const parent = new SessionWorkspaceRepository(this.database, parentSessionId)
    parent.assert()
    parent.initialize()
    this.assert()
    this.database.connection.prepare(`INSERT INTO session_workspaces(session_id,settings_json,revision,updated_at)
      SELECT ?,settings_json,0,? FROM session_workspaces WHERE session_id=?
      ON CONFLICT(session_id) DO UPDATE SET settings_json=excluded.settings_json,
        revision=session_workspaces.revision+1,updated_at=excluded.updated_at`).run(this.sessionId, Date.now(), parentSessionId)
  }

  private initialize(): void {
    if (this.database.connection.prepare('SELECT 1 FROM session_workspaces WHERE session_id=?').get(this.sessionId)) return
    const source = this.database.connection.prepare(`SELECT key,value_json FROM runtime_settings
      WHERE key IN ('workspace.root','workspace.selection','workspace.selection.default_resolution')`).all()
    const settings = Object.fromEntries(source.map(row => [String(row.key), JSON.parse(String(row.value_json))]))
    const seed = seedSessionWorkspace(settings)
    this.database.connection.prepare(`INSERT OR IGNORE INTO session_workspaces(session_id,settings_json,updated_at)
      VALUES (?,?,?)`).run(this.sessionId, JSON.stringify(seed), Date.now())
  }
}
