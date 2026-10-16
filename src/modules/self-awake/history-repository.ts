import type { EdenDatabase } from '@eden/store'
import type { SelfAwakeHistoryScope } from './history-scope.ts'

export class SelfAwakeHistoryRepository {
  constructor(private readonly database: EdenDatabase) {}

  diaries(scope: SelfAwakeHistoryScope, query: string, limit: number) {
    const { sql, params } = this.diaryScope(scope)
    const filter = "(?='' OR instr(lower(d.title),lower(?))>0 OR instr(lower(d.content),lower(?))>0)"
    const total = this.database.connection.prepare(`SELECT COUNT(*) AS n FROM self_awake_diaries d
      JOIN sessions s ON s.id=d.session_id WHERE ${sql}`).get(...params)
    const count = this.database.connection.prepare(`SELECT COUNT(*) AS n FROM self_awake_diaries d
      JOIN sessions s ON s.id=d.session_id WHERE ${sql} AND ${filter}`).get(...params, query, query, query)
    const rows = this.database.connection.prepare(`SELECT d.id,d.assistant_id,d.character_id,d.title,d.content,d.created_at
      FROM self_awake_diaries d JOIN sessions s ON s.id=d.session_id WHERE ${sql} AND ${filter}
      ORDER BY d.created_at DESC,d.id DESC LIMIT ?`).all(...params, query, query, query, limit)
    return { totalCount: Number(total?.n ?? 0), count: Number(count?.n ?? 0), rows }
  }

  /** Prefer pending plans; cap filesystem reads and disclose any incomplete coverage. */
  sessions(scope: SelfAwakeHistoryScope) {
    if (scope.kind === 'session') return { ids: [scope.sessionId], truncated: false }
    const rows = this.database.connection.prepare(`SELECT s.id FROM sessions s WHERE s.origin=? AND s.status='active'
      AND (? IS NULL OR s.id IN (SELECT session_id FROM session_owners WHERE account_key=?))
      AND EXISTS (SELECT 1 FROM json_each(COALESCE((SELECT json_extract(e.payload_json,'$.participants')
        FROM events e WHERE e.session_id=s.id AND e.kind IN ('session.created','session.metadata.updated')
        ORDER BY e.seq DESC LIMIT 1),'[]')) p
        WHERE CAST(COALESCE(json_extract(p.value,'$.characterId'),json_extract(p.value,'$.profile.character.id')) AS TEXT)=?)
      ORDER BY EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=s.id AND j.kind='self_awake' AND j.state='queued') DESC,
        s.updated_at DESC,s.id LIMIT 129`).all(scope.origin, scope.accountKey ?? null, scope.accountKey ?? null, scope.characterId!)
    return { ids: rows.slice(0, 128).map(row => String(row.id)), truncated: rows.length > 128 }
  }

  private diaryScope(scope: SelfAwakeHistoryScope) {
    if (scope.kind === 'session') return { sql: 'd.session_id=? AND s.origin=?', params: [scope.sessionId, scope.origin] }
    return { sql: `d.character_id=? AND s.origin=? AND (? IS NULL OR d.session_id IN
      (SELECT session_id FROM session_owners WHERE account_key=?))`,
    params: [scope.characterId!, scope.origin, scope.accountKey ?? null, scope.accountKey ?? null] }
  }
}
