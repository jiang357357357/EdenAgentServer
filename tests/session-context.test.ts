import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { sessionRoutes } from '../src/transport/rpc/session.routes.ts'

test('context returns latest complete request per actor, isolated to the requested session', async () => {
  const db = new EdenDatabase(':memory:', 'local')
  try {
    const repository = new SessionRepository(db, 'local')
    const a = repository.create('A'), b = repository.create('B'), empty = repository.create('empty')
    const emit = (id: string, actor: number, text: string) => repository.events.append(id, randomUUID(), 'model.request', {
      actor: { assistantID: actor }, model: 'fixture', payload: { messages: [{ role: 'system', content: text.repeat(600) }], tools: [] },
    })
    emit(a.id, 1, 'old')
    const second = emit(a.id, 2, 'second')
    const latest = emit(a.id, 1, 'current')
    emit(b.id, 1, 'other world session')
    repository.events.append(a.id, randomUUID(), 'memory.extraction.model_request', { payload: { secret: 'not conversation context' } })
    const read = sessionRoutes({ repository } as never)['session.context']!
    const result = await read({ sessionId: a.id }) as { requests: Array<{ id: string; payload: unknown }> }
    assert.deepEqual(result.requests.map(item => item.id), [latest.id, second.id])
    assert.deepEqual(result.requests[0]!.payload, latest.payload)
    assert.equal(JSON.stringify(result).includes('requestStorage'), false)
    assert.deepEqual(await read({ sessionId: empty.id }), { requests: [] })
    await assert.rejects(async () => read({ sessionId: randomUUID() }), /Session not found/)
    db.connection.prepare("UPDATE sessions SET status='deleted' WHERE id=?").run(a.id)
    await assert.rejects(async () => read({ sessionId: a.id }), /Session not found/)
  } finally { db.close() }
})
