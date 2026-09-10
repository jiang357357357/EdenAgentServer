import test from 'node:test'
import assert from 'node:assert/strict'
import { SelfAwakeBridge } from '../src/modules/self-awake/bridge.ts'

test('MonOs submission rejects sender-owned job and character fields before side effects', () => {
  const bridge = new SelfAwakeBridge({ secret: 'test-secret', userId: '2', coreBaseUrl: 'http://127.0.0.1:40011' },
    null as never, null as never, null as never)
  const request = { schema_version: 'self-awake.v1', user_id: '2', event_id: 'event', idempotency_key: 'request', context: { type: 'startup' } }
  for (const extra of [{ job_id: 'legacy-job' }, { assistant_id: null }, { character: { name: 'Eden' } }]) {
    assert.throws(() => bridge.submit({ ...request, ...extra }), /Unrecognized key/)
  }
  assert.throws(() => bridge.submit({ ...request, user_id: '1' }), /user mismatch/)
})
