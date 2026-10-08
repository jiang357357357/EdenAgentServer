import assert from 'node:assert/strict'
import test from 'node:test'
import { faultFixture } from './fault-recovery-fixture.ts'

test('a queued model change interrupts only its round, holds queued input and accepts a new current-model round', async t => {
  const f = await faultFixture(t), session = f.repository.create('Model change')
  const published: bigint[] = []
  f.repository.events.subscribe(event => { if (event.sessionId === session.id) published.push(BigInt(event.seq)) })
  const failed = f.sessions.start(session.id, 'Old model request'), held = f.sessions.start(session.id, 'Old queued request')
  f.setModel({ ...f.model.config, id: 'changed' })
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.input(failed.inputId).state, 'interrupted'); assert.equal(f.input(held.inputId).state, 'held')
  assert.equal(f.sessions.faultCount(), 0); assert.equal(f.model.requests.length, 0)
  assert.match(JSON.stringify(f.events(session.id)), /changed/)
  const accepted = f.sessions.start(session.id, 'Use the new model')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(accepted.inputId)
  assert.equal(f.input(held.inputId).state, 'held'); assert.equal(f.model.requests.length, 1)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()!.n, 3)
  assert.ok(published.every((seq, index) => !index || seq > published[index - 1]!))
})

test('a tool catalog execution error is not a storage fault and a fresh turn succeeds without restarting', async t => {
  const f = await faultFixture(t), session = f.repository.create('Catalog fault')
  f.failTools(new Error('catalog temporarily unavailable; apiKey=fixture-secret'))
  const failed = f.sessions.start(session.id, 'First')
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.input(failed.inputId).state, 'interrupted'); assert.equal(f.sessions.faultCount(), 0)
  const interrupted = f.events(session.id).find(event => event.kind === 'input.interrupted')!
  assert.match(JSON.stringify(interrupted.payload), /catalog temporarily unavailable/)
  assert.doesNotMatch(JSON.stringify(interrupted.payload), /fixture-secret/)
  f.failTools()
  const recovered = f.sessions.start(session.id, 'Try a fresh request')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(recovered.inputId)
  assert.equal(f.model.requests.length, 1)
})

test('model HTTP errors end the current turn and retain the original reason while the same session can continue', async t => {
  const f = await faultFixture(t, [{ status: 400, error: 'fixture invalid model request' }, { text: 'Next turn succeeds' }])
  const session = f.repository.create('HTTP failure'), failed = f.sessions.start(session.id, 'Invalid request')
  await f.sessions.waitForIdle(session.id)
  assert.equal(f.input(failed.inputId).state, 'interrupted'); assert.equal(f.sessions.faultCount(), 0)
  assert.match(JSON.stringify(f.events(session.id)), /fixture invalid model request/)
  const recovered = f.sessions.start(session.id, 'New request')
  await f.sessions.waitForIdle(session.id)
  f.assertCompleted(recovered.inputId)
  assert.equal(f.model.requests.length, 2)
})
