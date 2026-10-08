import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { EdenDatabase, databaseSchemaVersion } from '@eden/store'
import { migrations } from '@eden/store/testing'
import { accountKey, importAccountPartition, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'

const account = (userId: string) => ({ key: accountKey('http://127.0.0.1:1', userId), userId, coreBaseUrl: 'http://127.0.0.1:1' })

function seed(source: DatabaseSync, owner: string) {
  const sessionId = randomUUID(), turnId = randomUUID(), jobId = randomUUID(), runId = randomUUID()
  source.prepare('INSERT INTO sessions VALUES(?,?,?, ?,?,?)').run(sessionId, owner, 'mon', 'active', 0, 0)
  source.prepare('INSERT INTO session_owners VALUES(?,?)').run(sessionId, account(owner).key)
  const event = source.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
  event.run(randomUUID(), sessionId, null, 1, 'session.created', '{}', 1)
  for (const seq of [2, 3]) event.run(randomUUID(), sessionId, turnId, seq, 'model.request',
    JSON.stringify({ actor: { assistantID: 'actor' }, requestId: `${owner}-${seq}`, contextEstimate: { revision: seq } }), seq)
  event.run(randomUUID(), sessionId, turnId, 4, 'model.response', '{"usage":{"input":10,"output":2}}', 4)
  event.run(randomUUID(), sessionId, turnId, 5, 'model.response', '{"usage":{"input":20,"output":3}}', 5)
  event.run(randomUUID(), sessionId, turnId, 6, 'agent.agent_start', '{}', 50)
  source.prepare(`INSERT INTO jobs(id,kind,session_id,due_at,payload_json,operation_key,causation_id,depth,state,attempts,created_at,updated_at)
    VALUES(?,'self_awake',?,0,'{}',?,'',0,'completed',1,0,0)`).run(jobId, sessionId, jobId)
  source.prepare(`INSERT INTO self_awake_runs(id,job_id,session_id,turn_id,event_id,state,request_json,author_json,attempts,
    started_at,completed_at,created_at,updated_at) VALUES(?,?,?,?,'','completed','{}','{}',1,99999,100,0,100)`)
    .run(runId, jobId, sessionId, turnId)
  return { sessionId, runId }
}

for (const sourceVersion of [128, 130, 132]) {
  test(`account import rebuilds projections from schema ${sourceVersion} facts without copying stale heads`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eden-partition-projections-'))
    const legacyRoot = path.join(root, 'legacy'), targetRoot = path.join(root, 'account', 'storage')
    await mkdir(legacyRoot)
    const filename = path.join(legacyRoot, 'eden-agent.db')
    try {
      const source = new DatabaseSync(filename)
      let first: ReturnType<typeof seed>, second: ReturnType<typeof seed>
      try {
        source.exec('PRAGMA foreign_keys=ON')
        for (const sql of migrations.slice(0, sourceVersion)) source.exec(sql)
        source.exec(`PRAGMA user_version=${sourceVersion}; INSERT INTO realm_meta VALUES('origin','mon')`)
        first = seed(source, 'a')
        second = seed(source, 'b')
        if (sourceVersion >= 130) {
          // Projections are disposable: imported canonical facts, not source rowids or stale state, win.
          source.exec('UPDATE session_model_request_heads SET seq=2; UPDATE session_model_usage_heads SET seq=4; UPDATE self_awake_activations SET started_at=7')
        }
        if (sourceVersion >= 132) {
          for (const { sessionId } of [first, second]) {
            const job = randomUUID()
            source.prepare(`INSERT INTO jobs(id,kind,session_id,due_at,payload_json,operation_key,causation_id,depth,state,attempts,created_at,updated_at)
              VALUES(?,'self_awake',?,1000,'{}',?,'',0,'queued',0,40,40)`).run(job, sessionId, job)
            source.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job)
            source.prepare('UPDATE self_awake_session_schedules SET revision=1999,published_revision=1999 WHERE session_id=?').run(sessionId)
            source.prepare('INSERT INTO session_workspaces(session_id,settings_json,revision,updated_at) VALUES(?,?,7,40)')
              .run(sessionId, JSON.stringify({ 'workspace.root': `chosen-${sessionId}` }))
          }
        }
      } finally { source.close() }
      importAccountPartition(legacyRoot, targetRoot, account('a'))
      importAccountPartition(legacyRoot, targetRoot, account('a'))
      const target = new EdenDatabase(path.join(targetRoot, 'eden-agent.db'), 'mon')
      try {
        const repository = new SessionRepository(target, 'mon'), db = target.connection
        withAccount(account('a'), () => {
          assert.deepEqual(repository.list().map(item => item.id), [first.sessionId])
          assert.equal(repository.read(first.sessionId).contextTokens, 23)
          assert.deepEqual(repository.events.latestContextRequests(first.sessionId).map(item => item.seq), ['3'])
          assert.throws(() => repository.read(second.sessionId))
        })
        for (const table of ['session_model_request_heads', 'session_model_usage_heads', 'self_awake_activations'])
          assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1, table)
        assert.equal(db.prepare('SELECT started_at FROM self_awake_activations WHERE run_id=?').get(first.runId)?.started_at, 50)
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, 6)
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
        assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, databaseSchemaVersion)
        if (sourceVersion >= 132) {
          const schedule = db.prepare('SELECT * FROM self_awake_session_schedules WHERE session_id=?').get(first.sessionId)!
          assert.equal(schedule.job_id, null)
          assert.equal(schedule.revision, 1999)
          assert.equal(schedule.published_revision, 0, 'new account location must republish its scoped cancellation')
          assert.equal(schedule.initial_anchor, 40)
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM self_awake_session_schedules').get()?.n, 1)
          assert.equal(db.prepare('SELECT revision FROM session_workspaces WHERE session_id=?').get(first.sessionId)?.revision, 7)
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_workspaces').get()?.n, 1)
        }
      } finally { target.close() }
      const unchanged = new DatabaseSync(filename, { readOnly: true })
      try {
        assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, sourceVersion)
        assert.equal(unchanged.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, 12)
        if (sourceVersion >= 130) assert.equal(unchanged.prepare('SELECT MIN(started_at) AS value FROM self_awake_activations').get()?.value, 7)
      } finally { unchanged.close() }
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    }
  })
}
