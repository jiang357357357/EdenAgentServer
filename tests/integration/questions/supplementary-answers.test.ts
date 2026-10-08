import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { QuestionService } from '../../../src/modules/questions/index.ts'

test('both supplementary answer formats validate before persisting a resolved request', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const sessions = new SessionRepository(database, 'local')
  const service = new QuestionService(sessions)
  const session = sessions.create('Supplementary answers')
  const questions = [{ header: 'Output', question: 'Choose format', options: [{ label: 'JSON' }, { label: 'Text' }], custom: true }]
  try {
    const first = service.ask(session.id, randomUUID(), { questions }, new AbortController().signal)
    const request = service.list()[0]!
    assert.throws(() => service.resolve(request.id, [['JSON', 'Text']], ['note']), /one answer option/)
    assert.throws(() => service.resolve(request.id, [['unknown']], ['note']), /listed option/)
    assert.equal(service.list().length, 1)
    service.resolve(request.id, [['JSON']], ['additional details'])
    assert.deepEqual(await first, [['JSON', 'additional details']])
    const second = service.ask(session.id, randomUUID(), { questions }, new AbortController().signal)
    const legacy = service.list()[0]!
    assert.throws(() => service.resolve(legacy.id, [['JSON', 'note one', 'note two']]), /one supplementary answer/)
    service.resolve(legacy.id, [['JSON', 'legacy note']])
    assert.deepEqual(await second, [['JSON', 'legacy note']])
  } finally { service.close(); database.close() }
})
