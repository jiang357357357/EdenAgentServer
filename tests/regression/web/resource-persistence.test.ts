import assert from 'node:assert/strict'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WebResourceRepository } from '../../../src/modules/web/resource-repository.ts'

test('search and page references persist in the real seven-column table and survive repository recreation', t => {
  const database = new EdenDatabase(':memory:', 'local')
  t.after(() => database.close())
  const sessions = new SessionRepository(database, 'local')
  const session = sessions.create('Web resource persistence')
  const resources = new WebResourceRepository(database, sessions)
  for (const kind of ['search', 'page'] as const) {
    const refId = resources.put(session.id, kind, 'https://example.com/arona', 'Arona', 'Character profile')
    assert.match(refId, new RegExp(`^${kind}_`))
    const restored = new WebResourceRepository(database, sessions).get(session.id, refId)
    assert.deepEqual({ ...restored, createdAt: undefined }, {
      kind, url: 'https://example.com/arona', title: 'Arona', body: 'Character profile', createdAt: undefined,
    })
    assert.ok(Number.isSafeInteger(restored.createdAt) && restored.createdAt > 0)
    const other = sessions.create('Other session')
    assert.throws(() => resources.get(other.id, refId), /当前会话不存在网页引用/)
  }
})
