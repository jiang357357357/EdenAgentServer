import type { EdenDatabase } from '@eden/store'
import { AccountAuthentication } from './authentication.ts'
import { accountKey } from './context.ts'
import { SessionOwnership } from './ownership.ts'

/** Recover only server-verified credentials or signed scheduler submissions, never UI metadata. */
export async function recoverSessionOwners(database: EdenDatabase, auth: AccountAuthentication, serviceUserId?: string): Promise<void> {
  const ownership = new SessionOwnership(database)
  if (serviceUserId) {
    const rows = database.connection.prepare(`SELECT DISTINCT j.session_id FROM self_awake_submissions s JOIN jobs j ON j.id=s.job_id
      WHERE s.user_id=? AND j.session_id IS NOT NULL`).all(serviceUserId)
    for (const row of rows) ownership.assign(String(row.session_id), accountKey(auth.coreBaseUrl, serviceUserId))
  }
  const rows = database.connection.prepare(`SELECT c.session_id,c.core_base_url,c.core_token FROM mon_connections c
    WHERE NOT EXISTS(SELECT 1 FROM session_owners o WHERE o.session_id=c.session_id)`).all()
  const verified = new Map<string, string | null>()
  const candidates = rows.filter(row => new URL(String(row.core_base_url)).href.replace(/\/+$/, '') === new URL(auth.coreBaseUrl).href.replace(/\/+$/, ''))
  const tokens = [...new Set(candidates.map(row => String(row.core_token)))]
  const deadline = AbortSignal.timeout(5000)
  for (let offset = 0; offset < tokens.length && !deadline.aborted; offset += 4) {
    await Promise.all(tokens.slice(offset, offset + 4).map(async token => {
      try { verified.set(token, (await auth.verify(token, deadline)).key) }
      catch { verified.set(token, null) } // Unavailable credentials leave history unassigned; never claim it at login.
    }))
  }
  for (const row of candidates) {
    const key = verified.get(String(row.core_token))
    if (key) ownership.assign(String(row.session_id), key)
  }
  // Durable parent links allow child sessions to inherit verified ownership, including nested children.
  let changed: number
  do {
    const result = database.connection.prepare(`INSERT OR IGNORE INTO session_owners(session_id,account_key)
      SELECT t.child_session_id,o.account_key FROM subagent_threads t JOIN session_owners o ON o.session_id=t.parent_session_id`).run()
    changed = Number(result.changes)
  } while (changed)
  database.connection.exec(`INSERT OR IGNORE INTO account_records SELECT 'memo',m.id,o.account_key FROM memos m JOIN session_owners o ON o.session_id=m.related_session_id;
    INSERT OR IGNORE INTO account_records SELECT 'memory',m.id,o.account_key FROM memories m JOIN session_owners o ON o.session_id=m.source_session_id;`)
}
