import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimePersistenceError, isRuntimePersistenceFailure } from '@eden/runtime-pi'
import { SessionFaults, sessionFailureReason, sessionStorageFailure } from '../../../src/modules/sessions/session-faults.ts'

test('storage fault classification uses durable markers and SQLite codes rather than error wording', () => {
  assert.equal(sessionStorageFailure(new Error('Runtime persistence failed')), false)
  const sqlite = Object.assign(new Error('disk unavailable'), { code: 'ERR_SQLITE_ERROR' })
  assert.equal(sessionStorageFailure(new Error('outer', { cause: sqlite })), true)
  const checkpoint = new RuntimePersistenceError('checkpoint commit', new Error('fixture durable callback'))
  assert.equal(sessionStorageFailure(checkpoint), true)
  assert.equal(isRuntimePersistenceFailure(new AggregateError([new Error('execution'), checkpoint])), true)
  assert.equal(sessionStorageFailure(new AggregateError([new Error('execution'), sqlite])), true)
})

test('cyclic causes terminate and nested original reasons redact credentials', () => {
  const cyclic = new Error('catalog unavailable')
  cyclic.cause = cyclic
  assert.equal(sessionStorageFailure(cyclic), false)
  assert.equal(isRuntimePersistenceFailure(cyclic), false)
  assert.equal(sessionFailureReason(cyclic), 'catalog unavailable')
  const message = sessionFailureReason(new Error('outer', { cause: new Error('original; apiKey=fixture-secret-only') }))
  assert.match(message, /original/)
  assert.doesNotMatch(message, /fixture-secret-only/)
})

test('failed storage recovery remains blocked and jobs cannot initiate recovery', () => {
  let calls = 0, repaired = false
  const faults = new SessionFaults(() => { calls++; if (!repaired) throw new Error('still readonly') })
  assert.equal(faults.record('s', new Error('execution')), false)
  assert.equal(faults.size, 0)
  faults.record('s', new RuntimePersistenceError('checkpoint', new Error('disk failure')))
  assert.throws(() => faults.assertCanSubmit('s', false), /会话存储尚未恢复.*disk failure/)
  assert.equal(calls, 0)
  assert.throws(() => faults.assertCanSubmit('s', true), /会话存储尚未恢复.*still readonly/)
  assert.equal(faults.has('s'), true)
  repaired = true; faults.assertCanSubmit('s', true)
  assert.equal(calls, 2); assert.equal(faults.size, 0)
})
