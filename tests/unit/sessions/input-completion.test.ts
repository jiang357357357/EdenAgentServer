import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeCancellationError, RuntimeProcessError } from '@eden/runtime-pi'
import { inputCompletion } from '../../../src/modules/sessions/input/input-completion.ts'
import { userCancelledExecution, explicitlyCancelledExecution } from '../../../src/modules/sessions/session-faults.ts'

test('user cancellation is distinct from crash and cannot hide a concurrent storage failure', () => {
  const controller = new AbortController()
  const cancelled = new RuntimeCancellationError(true)
  assert.equal(userCancelledExecution(cancelled, controller.signal), false)
  controller.abort()
  assert.equal(explicitlyCancelledExecution(controller.signal, undefined), false, 'server shutdown must not become a user cancellation')
  assert.equal(userCancelledExecution(cancelled, controller.signal), true)
  assert.equal(userCancelledExecution(controller.signal.reason, controller.signal), true)
  assert.equal(userCancelledExecution(new RuntimeProcessError('crashed', 'crashed'), controller.signal), false)
  const completion = inputCompletion(cancelled.message, false, true)
  assert.equal(completion.state, 'cancelled'); assert.equal(completion.error, null)
  assert.equal(completion.event, 'input.cancelled')
  const storage = inputCompletion('checkpoint persistence failed', true, false)
  assert.equal(storage.state, 'cancelled')
  assert.equal(storage.error, 'checkpoint persistence failed')
  assert.equal(storage.event, 'input.interrupted')
  const user = new AbortController(); user.abort(new RuntimeCancellationError())
  assert.equal(explicitlyCancelledExecution(user.signal, undefined), true)
  assert.equal(explicitlyCancelledExecution(user.signal, new Error('storage failed')), false)
})
