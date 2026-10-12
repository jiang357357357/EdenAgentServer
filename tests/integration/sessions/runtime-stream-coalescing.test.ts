import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import type { DurableEvent, JsonValue, RuntimeCheckpoint } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { runtimeCallbacks, type RuntimeCallbackScope } from '../../../src/modules/sessions/turn/runtime-callbacks.ts'

function update(text: string, delta = text.at(-1)!) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  return { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: message } }
}

function fixture(t: TestContext) {
  t.mock.method(performance, 'now', () => 0)
  const database = new EdenDatabase(':memory:', 'local')
  t.after(() => database.close())
  const repository = new SessionRepository(database, 'local')
  const session = repository.create('Coalesced stream')
  const input = { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'fixture', state: 'running' }
  const events: DurableEvent[] = []
  repository.events.subscribe(event => events.push(event))
  const callbacks = (scope: RuntimeCallbackScope = {}) => runtimeCallbacks(repository, input, scope)
  return { database, repository, session, input, events, callbacks }
}

test('already coalesced child batches commit immediately without a second sampling window or payload metadata', async t => {
  const f = fixture(t), callbacks = f.callbacks()
  await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
  await callbacks.event('message_update', update('a'), { coalesced: true })
  await callbacks.event('message_update', update('abc', 'bc'), { coalesced: true })
  const updates = f.events.filter(event => event.kind === 'agent.message_update')
  assert.equal(updates.length, 2, 'Even at a fixed zero clock the second batch is durable before ACK')
  assert.equal((updates[1]!.payload as Record<string, JsonValue>).coalesced, undefined)
  assert.deepEqual((updates[1]!.payload as Record<string, JsonValue>).message, update('abc').message)
  assert.deepEqual(f.repository.events.list(f.session.id, '1'), f.events)
})

test('6000 fast SDK deltas use bounded durable writes, yield to I/O and preserve final output and contiguous history', async t => {
  const f = fixture(t), callbacks = f.callbacks()
  let transactions = 0, yielded = false
  const transaction = f.database.transaction.bind(f.database)
  t.mock.method(f.database, 'transaction', <T>(operation: () => T): T => { transactions++; return transaction(operation) })
  await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
  const io = setImmediate().then(() => { yielded = true })
  for (let index = 1; index <= 6000; index++) {
    await callbacks.event('message_update', update('中'.repeat(index), '中'))
    if (index === 32) assert.equal(yielded, true, 'A fast stream must allow pending I/O before completion')
  }
  const final = update('中'.repeat(6000)).message
  await callbacks.event('message_end', { message: final })
  await io
  const updates = f.events.filter(event => event.kind === 'agent.message_update')
  assert.equal(updates.length, 2)
  assert.equal(transactions, 4, 'One start, first delta, final coalesced delta and message end')
  const deltas = updates.map(event => (event.payload as Record<string, JsonValue>).assistantMessageEvent as Record<string, JsonValue>)
  assert.equal(deltas.map(value => value.delta).join(''), '中'.repeat(6000))
  assert.deepEqual((updates.at(-1)!.payload as Record<string, JsonValue>).message, final)
  assert.deepEqual((f.events.at(-1)!.payload as Record<string, JsonValue>).message, final)
  const restored = f.repository.events.list(f.session.id, '1', 100)
  assert.deepEqual(restored, f.events)
  assert.deepEqual(restored.map(event => event.seq), ['2', '3', '4', '5'])
  t.diagnostic(`6000 update callbacks -> ${updates.length} durable updates; ${transactions} event transactions including boundaries`)
})

for (const boundary of ['message_end', 'agent_end', 'error', 'request', 'response', 'checkpoint', 'beforeTool', 'afterTool']) {
  test(`short streams flush before ${boundary}, including cancellation and failure boundaries`, async t => {
    const f = fixture(t)
    const callbacks = f.callbacks({ checkpoint: async () => {
      f.repository.events.append(f.session.id, f.input.turnId, 'fixture.checkpoint', {})
    } })
    if (boundary === 'afterTool') await callbacks.beforeTool!('fixture', 'call', '1', {})
    await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
    await callbacks.event('message_update', update('a'))
    await callbacks.event('message_update', update('ab'))
    const count = f.events.length
    if (boundary === 'request') await callbacks.request({ requestId: 'request', payload: { messages: [] } })
    else if (boundary === 'response') await callbacks.response!({ requestId: 'request', message: { stopReason: 'aborted' } })
    else if (boundary === 'checkpoint') await callbacks.checkpoint({} as RuntimeCheckpoint)
    else if (boundary === 'beforeTool') await callbacks.beforeTool!('fixture', 'call', '1', {})
    else if (boundary === 'afterTool') await callbacks.afterTool!('call', { error: 'cancelled' }, true, 'cancelled')
    else await callbacks.event(boundary, boundary === 'message_end' ? { message: update('ab').message } : { reason: 'aborted' })
    assert.equal(f.events[count]?.kind, 'agent.message_update')
    assert.deepEqual((f.events[count]!.payload as Record<string, JsonValue>).message, update('ab').message)
    assert.equal(f.events.length, count + 2)
    await setImmediate()
    assert.equal(f.events.length, count + 2, 'No callback may schedule a late database write')
  })
}

test('interleaved actors and recreated message streams never share pending snapshots or delta text', async t => {
  const f = fixture(t)
  const actors = [f.callbacks({ actor: { assistantID: 'a' } }), f.callbacks({ actor: { assistantID: 'b' } })]
  for (const callbacks of actors) await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
  for (let index = 0; index < actors.length; index++) {
    await actors[index]!.event('message_update', update(String(index)))
    await actors[index]!.event('message_update', update(`${index}!`))
  }
  await actors[1]!.event('message_end', { message: update('1!').message })
  await actors[0]!.event('agent_end', { reason: 'aborted' })
  for (const [index, actor] of ['a', 'b'].entries()) {
    const updates = f.events.filter(event => event.kind === 'agent.message_update'
      && ((event.payload as Record<string, JsonValue>).actor as Record<string, JsonValue>).assistantID === actor)
    assert.equal(updates.length, 2)
    assert.deepEqual((updates[1]!.payload as Record<string, JsonValue>).message, update(`${index}!`).message)
  }
  await actors[0]!.event('message_start', { message: { role: 'assistant', content: [] } })
  const count = f.events.length
  await actors[0]!.event('message_update', update('new'))
  assert.equal(f.events.length, count + 1, 'A new message starts streaming immediately')
})

test('failed pending persistence publishes nothing and blocks subsequent tool intents even after storage recovers', async t => {
  const f = fixture(t), callbacks = f.callbacks()
  await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
  await callbacks.event('message_update', update('a'))
  await callbacks.event('message_update', update('ab'))
  const count = f.events.length
  f.database.connection.exec("CREATE TRIGGER reject_stream BEFORE INSERT ON events WHEN NEW.kind='agent.message_update' BEGIN SELECT RAISE(ABORT, 'stream disk failure'); END")
  await assert.rejects(callbacks.beforeTool!('fixture', 'call', '1', {}), /stream disk failure/)
  assert.equal(f.events.length, count)
  assert.equal(f.database.connection.prepare('SELECT count(*) AS count FROM tool_operations').get()?.count, 0)
  f.database.connection.exec('DROP TRIGGER reject_stream')
  await assert.rejects(callbacks.event('agent_end', {}), /stream disk failure/)
  await assert.rejects(callbacks.beforeTool!('fixture', 'second', '1', {}), /stream disk failure/)
  await setImmediate()
  assert.equal(f.events.length, count)
  assert.equal(f.repository.events.list(f.session.id, '1').length, count)
})
