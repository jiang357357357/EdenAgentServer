import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { EdenDatabase, migrateDatabase, databaseSchemaVersion } from '@eden/store'
import { migrations } from '@eden/store/testing'
import { rpcMethods } from '@eden/api'
import { withAccount } from '../../../src/modules/accounts/context.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { SelfAwakeBridgeRepository } from '../../../src/modules/self-awake/bridge-repository.ts'

function beforeDiaryMigration(current: EdenDatabase): DatabaseSync {
  const legacy = new DatabaseSync(':memory:')
  try {
    const version = migrations.findIndex(statement => statement.includes('ADD COLUMN diary_cleared '))
    assert.ok(version >= 0, 'Diary-cleared migration is present in public schema history')
    for (let index = 0; index < version; index++) {
      legacy.exec(migrations[index]!)
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(index + 1, Date.now())
    }
    legacy.exec(`PRAGMA user_version=${version}`)
    for (const table of ['sessions', 'jobs', 'events', 'self_awake_runs', 'self_awake_diaries']) {
      const columns = legacy.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
      const insert = legacy.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of current.connection.prepare(`SELECT * FROM ${table}`).all()) {
        insert.run(...columns.map(column => row[column]!))
      }
    }
    return legacy
  } catch (error) { legacy.close(); throw error }
}

test('clearing diaries covers unloaded pages, isolates accounts and preserves executions and future writing', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const repo = new SelfAwakeRepository(db), sessions = new SessionRepository(db, 'mon')
    const bridge = new SelfAwakeBridgeRepository(db, new JobRepository(db))
    const account = (userId: string) => ({ key: userId, userId, coreBaseUrl: 'http://localhost/' })
    const create = (userId: string, key: string, content: string) => withAccount(account(userId), () => {
      const session = sessions.create(key)
      const job = bridge.submit(userId, key, key, { kind: 'self_awake', sessionId: session.id, dueAt: Date.now(), payload: {}, key, causationId: '', depth: 0 })
      const id = repo.begin(job, { topic: 'request-only' }, { characterId: key })
      db.connection.prepare("UPDATE self_awake_runs SET state='running' WHERE id=?").run(id)
      if (content) repo.finish(id, content)
      return id
    })
    const first = create('a', 'first', '今天看见一只猫。')
    create('a', 'second', '很想分享给你。')
    const failed = create('a', 'failed', '')
    const other = create('b', 'other', '另一个人的日记。')
    withAccount(account('a'), () => {
      assert.throws(() => repo.clearHistory(), /仍有自醒正在处理/)
      assert.equal(repo.list({}).count, 3)
      repo.fail(failed, 'provider unavailable')
      assert.equal(repo.read(failed).lastError, 'provider unavailable')
      assert.equal(repo.read(failed).diaries.length, 0)
      assert.equal(repo.list({ diariesOnly: true, pageSize: 1 }).count, 2)
      assert.equal(repo.list({ diariesOnly: true, query: '猫' }).count, 1)
      assert.equal(repo.list({ diariesOnly: true, query: 'request-only' }).count, 0)
      const schedule = repo.wakeSchedule()
      const jobs = db.connection.prepare('SELECT count(*) AS n FROM jobs').get()!.n
      const result = repo.clearDiaries()
      assert.equal(result.deleted, 2)
      assert.equal(repo.read(first).diaryCleared, true)
      assert.equal(repo.read(failed).diaryCleared, false)
      assert.ok(result.clearedAt > 0)
      assert.equal(repo.list({ diariesOnly: true }).count, 0)
      assert.equal(repo.list({}).count, 3)
      assert.deepEqual(repo.wakeSchedule(), schedule)
      assert.equal(db.connection.prepare('SELECT count(*) AS n FROM jobs').get()!.n, jobs)
      repo.finish(first, '旧任务重复回调')
      assert.equal(repo.read(first).diaries.length, 0)
      assert.equal(repo.clearDiaries().deleted, 0)
    })
    withAccount(account('b'), () => { assert.equal(repo.read(other).diaries.length, 1); assert.equal(repo.read(other).diaryCleared, false) })
    const fresh = create('a', 'fresh', '新的一天。')
    withAccount(account('a'), () => {
      assert.equal(repo.read(fresh).diaries[0]!.content, '新的一天。')
      const schedule = repo.wakeSchedule()
      db.connection.prepare('INSERT INTO self_awake_run_reviews VALUES(?,?,?,?,?,?)').run(first, 'hash', '{}', 'completed', 'review', 1)
      assert.equal(repo.clearHistory().deleted, 4)
      assert.equal(repo.list({}).count, 0)
      assert.equal(repo.list({ diariesOnly: true }).count, 0)
      assert.throws(() => repo.execution(first), /not found/)
      assert.equal(repo.clearHistory().deleted, 0)
      assert.deepEqual(repo.wakeSchedule(), schedule)
    })
    withAccount(account('b'), () => assert.equal(repo.read(other).diaries.length, 1))
    const afterHistory = create('a', 'after-history', '清理之后的新日记。')
    withAccount(account('a'), () => assert.equal(repo.read(afterHistory).diaries.length, 1))
  } finally { db.close() }
})

test('diary clearing requires explicit confirmation and rejects a caller-supplied account scope', () => {
  const schema = rpcMethods['self_awake.diaries.clear'].params
  assert.equal(schema.safeParse({}).success, false)
  assert.equal(schema.safeParse({ confirmClear: false }).success, false)
  assert.equal(schema.safeParse({ confirmClear: true, accountId: 'someone-else' }).success, false)
  assert.equal(schema.safeParse({ confirmClear: true }).success, true)
})

test('upgrade recognizes previously cleared completed diaries without marking failed or existing diaries', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const session = new SessionRepository(db, 'mon').create('upgrade')
    const repo = new SelfAwakeRepository(db)
    const bridge = new SelfAwakeBridgeRepository(db, new JobRepository(db))
    const ids: string[] = []
    for (let index = 0; index < 3; index++) {
      const key = `upgrade-${index}`
      const job = bridge.submit('a', key, key, { kind: 'self_awake', sessionId: session.id, dueAt: Date.now(), payload: {}, key, causationId: '', depth: 0 })
      const id = repo.begin(job, {}, {})
      ids.push(id)
      db.connection.prepare("UPDATE self_awake_runs SET state='running',turn_id=? WHERE id=?").run(key, id)
      db.connection.prepare("INSERT INTO events(id,session_id,turn_id,seq,kind,payload_json,created_at) VALUES(?,?,?,?,'agent.message_end',?,1)")
        .run(key, session.id, key, index + 100, JSON.stringify({ message: { role: 'assistant', content: '今天的日记。' } }))
      if (index === 2) repo.fail(id, 'failed')
      else repo.finish(id, '今天的日记。')
    }
    db.connection.prepare('DELETE FROM self_awake_diaries WHERE run_id=?').run(ids[0]!)
    const legacy = beforeDiaryMigration(db)
    try {
      migrateDatabase(legacy)
      const cleared = (id: string) => legacy.prepare('SELECT diary_cleared FROM self_awake_runs WHERE id=?').get(id)!.diary_cleared
      assert.equal(cleared(ids[0]!), 1)
      assert.equal(cleared(ids[1]!), 0)
      assert.equal(legacy.prepare('SELECT count(*) AS n FROM self_awake_diaries WHERE run_id=?').get(ids[1]!)!.n, 1)
      assert.equal(cleared(ids[2]!), 0)
      assert.equal(legacy.prepare('PRAGMA user_version').get()!.user_version, databaseSchemaVersion)
      migrateDatabase(legacy)
      assert.equal(cleared(ids[0]!), 1)
    } finally { legacy.close() }
  } finally { db.close() }
})
