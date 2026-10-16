import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { EdenDatabase } from '@eden/store'

/** An account-owned routing declaration; execution timestamps still come only from activation facts. */
export function publishRoleCoordinator(database: EdenDatabase, stateFile: string): void {
  const key = database.connection.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()?.value
  if (typeof key !== 'string') return
  const account: unknown = JSON.parse(key)
  if (!Array.isArray(account) || account.length !== 2 || typeof account[1] !== 'string') throw new Error('角色自醒账号声明无效')
  const rows = database.connection.prepare(`SELECT r.session_id FROM self_awake_role_scopes r JOIN sessions s ON s.id=r.session_id
    WHERE r.account_key=? AND s.status='active' ORDER BY r.session_id`).all(key)
  const filename = path.join(path.dirname(stateFile), 'role-coordinator.json')
  if (!rows.length) {
    try {
      const previous = JSON.parse(readFileSync(filename, 'utf8'))
      if (previous.user_id !== account[1]) throw new Error('角色自醒账号声明冲突')
      rmSync(filename)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    return
  }
  const content = JSON.stringify({ schema_version: 'self-awake.roles.v1', user_id: account[1], session_ids: rows.map(row => String(row.session_id)) })
  try { if (readFileSync(filename, 'utf8') === content) return }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.tmp`
  try { writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, filename) }
  finally { rmSync(temporary, { force: true }) }
}
