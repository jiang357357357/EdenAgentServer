import type { EdenDatabase } from '@eden/store'
import type { JobRepository } from '../jobs/index.ts'
import type { JobSchedule } from '@eden/api'

export class SelfAwakeBridgeRepository {
  constructor(private readonly database: EdenDatabase, private readonly jobs: JobRepository) {}
  consumeNonce(nonce: string, expiresAt: number): void {
    this.database.transaction(() => {
      this.database.connection.prepare('DELETE FROM service_nonces WHERE expires_at<?').run(Date.now())
      if (Number(this.database.connection.prepare('SELECT COUNT(*) AS count FROM service_nonces').get()?.count) >= 10000) throw new Error('Service nonce capacity reached')
      this.database.connection.prepare('INSERT INTO service_nonces(nonce,expires_at) VALUES(?,?)').run(nonce, expiresAt)
    })
  }
  existing(user: string, key: string, hash: string) {
    const row = this.database.connection.prepare('SELECT job_id,request_hash FROM self_awake_submissions WHERE user_id=? AND request_key=? UNION ALL SELECT job_id,request_hash FROM self_awake_submission_aliases WHERE user_id=? AND request_key=?').get(user, key, user, key)
    if (!row) return undefined
    if (row.request_hash !== hash) throw new Error('Idempotency key was used with a different request')
    return this.jobs.read(String(row.job_id))
  }
  coalesce(user: string, key: string, hash: string, sessionId?: string) {
    return this.database.transaction(() => {
      const existing = this.existing(user, key, hash)
      if (existing) return existing
      const row = this.database.connection.prepare(`SELECT j.id FROM jobs j
        LEFT JOIN self_awake_runs r ON r.job_id=j.id LEFT JOIN self_awake_submissions s ON s.job_id=j.id
        WHERE j.kind='self_awake' AND (s.user_id=? OR (? IS NOT NULL AND s.user_id IS NULL))
          AND ((? IS NOT NULL AND j.session_id=?) OR (? IS NULL AND COALESCE(json_extract(j.payload_json,'$.scheduleScope'),'legacy')='legacy')) AND
          (j.state IN ('queued','running','dispatched','unknown') OR r.state IN ('running','awaiting_action','action_running','action_interrupted'))
        ORDER BY j.created_at LIMIT 1`).get(user, sessionId ?? null, sessionId ?? null, sessionId ?? null, sessionId ?? null)
      if (!row) return undefined
      return this.attach(user, key, hash, String(row.id))
    })
  }
  attach(user: string, key: string, hash: string, jobId: string) {
    const job = this.jobs.read(jobId)
    const owner = this.database.connection.prepare('SELECT user_id FROM self_awake_submissions WHERE job_id=?').get(jobId)
    if (owner && owner.user_id !== user) throw new Error('Self-awake plan owner mismatch')
    const table = owner ? 'self_awake_submission_aliases' : 'self_awake_submissions'
    this.database.connection.prepare(`INSERT INTO ${table}(user_id,request_key,request_hash,job_id) VALUES(?,?,?,?)`).run(user, key, hash, jobId)
    return job
  }
  recent(user: string, key: string, hash: string, sessionId: string) {
    return this.database.transaction(() => {
      const row = this.database.connection.prepare(`SELECT j.id FROM jobs j JOIN self_awake_runs r ON r.job_id=j.id
        JOIN self_awake_activations a ON a.run_id=r.id WHERE j.session_id=? AND j.state='completed' AND r.state='completed'
        AND a.started_at>? ORDER BY a.started_at DESC LIMIT 1`).get(sessionId, Date.now() - 12 * 3600000)
      return row ? this.attach(user, key, hash, String(row.id)) : undefined
    })
  }
  activate(user: string, key: string, hash: string, sessionId: string, jobId: string) {
    return this.database.transaction(() => {
      const existing = this.existing(user, key, hash)
      if (existing) {
        if (existing.sessionId !== sessionId || existing.id !== jobId) throw new Error('Self-awake request belongs to another session plan')
        return existing
      }
      const job = this.jobs.read(jobId)
      if (job.kind !== 'self_awake' || job.sessionId !== sessionId) throw new Error('Self-awake plan does not belong to the requested session')
      if (job.state !== 'queued') throw new Error('Self-awake plan is no longer pending')
      if (job.dueAt > Date.now() + 1000) throw new Error('Self-awake plan is not due')
      const payload = job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload) ? job.payload : {}
      this.database.connection.prepare('UPDATE jobs SET payload_json=?,updated_at=? WHERE id=? AND state=\'queued\'')
        .run(JSON.stringify({ ...payload, scheduler: 'monos', scheduleScope: payload.roleScope ? 'role' : 'session', userId: user }), Date.now(), jobId)
      const owner = this.database.connection.prepare('SELECT user_id FROM self_awake_submissions WHERE job_id=?').get(jobId)
      if (owner && owner.user_id !== user) throw new Error('Self-awake plan owner mismatch')
      const table = owner ? 'self_awake_submission_aliases' : 'self_awake_submissions'
      this.database.connection.prepare(`INSERT INTO ${table}(user_id,request_key,request_hash,job_id) VALUES(?,?,?,?)`).run(user, key, hash, jobId)
      return this.jobs.read(jobId)
    })
  }
  submit(user: string, key: string, hash: string, input: JobSchedule) {
    return this.database.transaction(() => {
      const existing = this.existing(user, key, hash)
      if (existing) return existing
      const job = this.jobs.scheduleInTransaction(input)
      this.database.connection.prepare('INSERT INTO self_awake_submissions(user_id,request_key,request_hash,job_id) VALUES(?,?,?,?)').run(user, key, hash, job.id)
      return job
    })
  }
  status(user: string, id: string) {
    if (!this.database.connection.prepare('SELECT 1 FROM self_awake_submissions WHERE user_id=? AND job_id=?').get(user, id)) throw new Error('Self-awake job owner mismatch')
    const job = this.jobs.read(id)
    const run = this.database.connection.prepare(`SELECT r.id,r.state,r.decision_json,r.last_error,a.started_at,r.updated_at
      FROM self_awake_runs r LEFT JOIN self_awake_activations a ON a.run_id=r.id WHERE r.job_id=?`).get(id)
    const state = job.state === 'failed' ? 'failed' : String(run?.state ?? job.state)
    // MonOs polls only pending/running; exposing queued would finish the wake prematurely.
    const status = ['queued', 'preparing'].includes(state) ? 'pending'
      : ['running', 'dispatched', 'awaiting_action', 'action_running'].includes(state) ? 'running'
      : state === 'completed' ? 'completed' : 'failed'
    const diary = run && state === 'completed' ? this.database.connection.prepare('SELECT title,content FROM self_awake_diaries WHERE run_id=?').get(run.id!) : undefined
    return { id: run ? String(run.id) : id, status,
      started_at: run?.started_at == null ? null : new Date(Number(run.started_at)).toISOString(),
      decision_payload: run?.decision_json ? JSON.parse(String(run.decision_json)) : diary ? { diary: { title: String(diary.title), content: String(diary.content) } } : null,
      error: run?.last_error ?? job.error, updated_at: new Date(Number(run?.updated_at ?? job.updatedAt)).toISOString() }
  }
}
