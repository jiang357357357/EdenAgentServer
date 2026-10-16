import type { EdenDatabase } from '@eden/store'
import type { SessionRepository } from '../sessions/index.ts'
import type { JobRepository } from '../jobs/index.ts'
import { accountFilter, SessionOwnership } from '../accounts/index.ts'
import { wakeRoleIdentity, type WakeRoleIdentity } from './role-identity.ts'

export class SelfAwakeRoleRepository {
  constructor(readonly database: EdenDatabase) {}

  target(sessionId: string): string {
    new SessionOwnership(this.database).assert(sessionId)
    const row = this.database.connection.prepare(`SELECT s.session_id FROM self_awake_role_members m
      JOIN self_awake_role_scopes s ON s.scope_key=m.scope_key WHERE m.session_id=?`).get(sessionId)
    return row ? String(row.session_id) : sessionId
  }

  find(identity: WakeRoleIdentity): string | undefined {
    const row = this.database.connection.prepare(`SELECT r.session_id FROM self_awake_role_scopes r
      JOIN sessions s ON s.id=r.session_id WHERE r.scope_key=? AND s.status='active'`).get(identity.key)
    if (!row) return undefined
    new SessionOwnership(this.database).assert(String(row.session_id))
    return String(row.session_id)
  }

  register(sessions: SessionRepository, sessionId: string): string {
    const identity = wakeRoleIdentity(sessions, sessionId)
    if (!identity) return sessionId
    const write = () => {
      const target = this.find(identity)
      if (!target) this.database.connection.prepare(`INSERT INTO self_awake_role_scopes VALUES(?,?,?,?,?)
        ON CONFLICT(scope_key) DO UPDATE SET session_id=excluded.session_id`).run(identity.key, identity.accountKey, identity.characterId, sessionId, Date.now())
      const member = this.database.connection.prepare('SELECT scope_key FROM self_awake_role_members WHERE session_id=?').get(sessionId)
      if (member && member.scope_key !== identity.key) throw new Error('后台自醒的角色归属已变化，需人工核对历史计划')
      this.database.connection.prepare('INSERT OR IGNORE INTO self_awake_role_members(session_id,scope_key) VALUES(?,?)').run(sessionId, identity.key)
      this.database.connection.prepare(`INSERT OR IGNORE INTO self_awake_session_schedules(session_id,job_id,revision,initial_anchor)
        VALUES(?,NULL,?,?)`).run(target ?? sessionId, Date.now(), Date.now())
      if (!target) this.database.connection.prepare('UPDATE self_awake_session_schedules SET revision=MAX(revision+1,?) WHERE session_id=?').run(Date.now(), sessionId)
      return target ?? sessionId
    }
    return this.database.inTransaction ? write() : this.database.transaction(write)
  }

  payload(sessionId: string) {
    const row = this.database.connection.prepare(`SELECT scope_key FROM self_awake_role_scopes WHERE session_id=?`).get(sessionId)
    return row ? { scheduleScope: 'role', roleScope: String(row.scope_key) } : { scheduleScope: 'session' }
  }

  schedulerKind(sessionId: string): 'role' | 'retired' | 'session_task' {
    const row = this.database.connection.prepare(`SELECT r.session_id,s.status FROM self_awake_role_members m
      JOIN self_awake_role_scopes r ON r.scope_key=m.scope_key JOIN sessions s ON s.id=r.session_id WHERE m.session_id=?`).get(sessionId)
    return row ? row.session_id === sessionId && row.status === 'active' ? 'role' : 'retired' : 'session_task'
  }

  /** Only autonomous background sessions are adopted. Memo deadlines are never touched. */
  reconcile(sessions: SessionRepository, jobs: JobRepository, before?: () => void): void {
    this.database.transaction(() => {
      before?.()
      const rows = this.database.connection.prepare(`SELECT s.id FROM sessions s JOIN session_classification c ON c.session_id=s.id
        WHERE s.status='active' AND c.purpose='self_awake' AND ${accountFilter(this.database, 's.id')} ORDER BY s.created_at DESC,s.id`).all()
      for (const row of rows) this.register(sessions, String(row.id))
      const scopes = this.database.connection.prepare(`SELECT scope_key,session_id FROM self_awake_role_scopes WHERE ${accountFilter(this.database, 'session_id')}`).all()
      for (const scope of scopes) this.merge(String(scope.scope_key), String(scope.session_id), jobs)
    })
  }

  merged(sessionId: string) {
    new SessionOwnership(this.database).assert(sessionId)
    return this.database.connection.prepare(`SELECT p.due_at,p.payload_json FROM self_awake_merged_plans p
      JOIN self_awake_role_members m ON m.scope_key=p.scope_key WHERE m.session_id=? AND p.reviewed_at IS NULL ORDER BY p.due_at,p.job_id`).all(sessionId)
      .map(row => { const payload = JSON.parse(String(row.payload_json)); return { plannedAt: new Date(Number(row.due_at)).toISOString(), reason: String(payload.prompt ?? payload.trigger?.reason ?? '') } })
  }

  private merge(key: string, target: string, jobs: JobRepository): void {
    const db = this.database.connection, now = Date.now()
    const rows = db.prepare(`SELECT j.id FROM jobs j JOIN self_awake_role_members m ON m.session_id=j.session_id
      WHERE m.scope_key=? AND j.kind='self_awake' AND j.state='queued' ORDER BY j.due_at,j.created_at DESC,j.id`).all(key)
    const plans = rows.map(row => jobs.read(String(row.id)))
    if (plans.length > 1 || plans.some(plan => plan.sessionId !== target)) {
      for (const plan of plans) {
        db.prepare('INSERT OR IGNORE INTO self_awake_merged_plans(job_id,scope_key,session_id,due_at,payload_json,merged_at) VALUES(?,?,?,?,?,?)').run(plan.id, key, plan.sessionId!, plan.dueAt, JSON.stringify(plan.payload), now)
        db.prepare("UPDATE jobs SET state='cancelled',error='Merged into the role self-awake clock; original plan retained',updated_at=? WHERE id=? AND state='queued'").run(now, plan.id)
      }
      const first = plans[0]!
      const payload = first.payload && typeof first.payload === 'object' && !Array.isArray(first.payload) ? first.payload : {}
      const { scheduler: _scheduler, ...retained } = payload
      jobs.scheduleInTransaction({ kind: 'self_awake', sessionId: target, dueAt: first.dueAt,
        payload: { ...retained, ...this.payload(target) }, key: `role-merge:${first.id}`, causationId: first.id, depth: first.depth })
    } else if (plans[0]) {
      const plan = plans[0], payload = plan.payload && typeof plan.payload === 'object' && !Array.isArray(plan.payload) ? plan.payload : {}
      if (payload.roleScope !== key) db.prepare('UPDATE jobs SET payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...payload, ...this.payload(target) }), now, plan.id)
    }
    // An old scope with no queued job may still have MonOs's twelve-hour fallback enabled.
    db.prepare(`INSERT INTO self_awake_session_schedules(session_id,job_id,revision,initial_anchor)
      SELECT m.session_id,NULL,?,? FROM self_awake_role_members m WHERE m.scope_key=? AND m.session_id!=? AND m.retired=0
      ON CONFLICT(session_id) DO UPDATE SET job_id=NULL,revision=MAX(revision+1,excluded.revision)
      `).run(now, now, key, target)
    db.prepare('UPDATE self_awake_role_members SET retired=CASE WHEN session_id=? THEN 0 ELSE 1 END WHERE scope_key=?').run(target, key)
    // Busy/unknown historical runs also occupy the role slot; migration never retries their effects.
    db.prepare(`UPDATE jobs SET payload_json=json_set(payload_json,'$.roleScope',?,'$.scheduleScope','role') WHERE kind='self_awake'
      AND (state IN ('running','dispatched','unknown') OR EXISTS(SELECT 1 FROM self_awake_runs r WHERE r.job_id=jobs.id
        AND r.state IN ('running','awaiting_action','action_running','action_interrupted')))
      AND session_id IN (SELECT session_id FROM self_awake_role_members WHERE scope_key=?)`).run(key, key)
  }
}
