import { randomUUID } from 'node:crypto'
import type { EdenDatabase } from '@eden/store'
import type { SessionRepository } from '../sessions/index.ts'

export interface WebResource { kind: 'search' | 'page'; url: string; title: string; body: string; createdAt: number }

export class WebResourceRepository {
  constructor(private readonly database: EdenDatabase, private readonly sessions: SessionRepository) {}

  put(sessionId: string, kind: WebResource['kind'], url: string, title: string, body: string): string {
    this.sessions.read(sessionId)
    const refId = `${kind}_${randomUUID()}`
    this.database.transaction(() => {
      this.database.connection.prepare('INSERT INTO web_resources VALUES (?,?,?,?,?,?)')
        .run(sessionId, refId, kind, url, title, body, Date.now())
      this.database.connection.prepare(`DELETE FROM web_resources WHERE session_id=? AND ref_id NOT IN (
        SELECT ref_id FROM web_resources WHERE session_id=? ORDER BY created_at DESC,ref_id DESC LIMIT 128)`).run(sessionId, sessionId)
    })
    return refId
  }

  get(sessionId: string, refId: string): WebResource {
    this.sessions.read(sessionId)
    const row = this.database.connection.prepare('SELECT kind,url,title,body,created_at FROM web_resources WHERE session_id=? AND ref_id=?').get(sessionId, refId)
    if (!row) throw new Error(`当前会话不存在网页引用 ${refId}`)
    return { kind: row.kind === 'page' ? 'page' : 'search', url: String(row.url), title: String(row.title),
      body: String(row.body), createdAt: Number(row.created_at) }
  }
}
