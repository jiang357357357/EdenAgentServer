import assert from 'node:assert/strict'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SelfAwakeRepository } from '../src/modules/self-awake/repository.ts'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { JobRepository } from '../src/modules/jobs/repository.ts'

for (const origin of ['mon', 'local'] as const) {
  test(`self-awake list supports empty records, search, pagination and schedule in ${origin}`, () => {
    const database = new EdenDatabase(':memory:', origin)
    try {
      const repository = new SelfAwakeRepository(database)
      assert.deepEqual(repository.list({}), { schedule: null, count: 0, page: 1, pageSize: 20, totalPages: 0, results: [] })
      const session = new SessionRepository(database, origin).create('Self-awake')
      const jobs = new JobRepository(database)
      const dueAt = Date.now() + 60_000
      for (const [index, prompt] of ['Alpha observation', '日记内容'].entries()) {
        const job = jobs.schedule({ kind: 'self_awake', sessionId: session.id, dueAt: dueAt + index * 1000,
          payload: { prompt }, key: `wake-${index}`, causationId: '', depth: 0 })
        const id = repository.begin(job, { prompt }, {})
        if (index === 1) database.connection.prepare('UPDATE self_awake_runs SET decision_json=? WHERE id=?')
          .run(JSON.stringify({ summary: 'Beta decision' }), id)
      }
      const first = repository.list({ pageSize: 1 })
      const second = repository.list({ pageSize: 1, page: 2 })
      assert.equal(first.count, 2)
      assert.equal(first.totalPages, 2)
      assert.equal(first.results.length, 1)
      assert.equal(second.results.length, 1)
      assert.notEqual(first.results[0]!.id, second.results[0]!.id)
      assert.deepEqual(first.schedule, { status: 'scheduled', nextWakeAt: new Date(dueAt).toISOString(), reason: 'Alpha observation' })
      for (const query of [' ALPHA ', '日记', 'beta']) assert.equal(repository.list({ query }).count, 1)
      const missing = repository.list({ query: "missing' OR 1=1 --" })
      assert.equal(missing.count, 0)
      assert.deepEqual(missing.results, [])
      assert.deepEqual(missing.schedule, first.schedule)
    } finally { database.connection.close() }
  })
}
