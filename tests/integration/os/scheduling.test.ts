import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { osFixture } from '../../helpers/os-config.ts'
import { readState, saveState } from '../../../src/modules/os/state-store.ts'
import { WakeSession } from '../../../src/modules/os/wake-session.ts'
import { WakeRoot } from '../../../src/modules/os/wake-root.ts'
import { OsScheduler } from '../../../src/modules/os/scheduler.ts'
import { OsCoreClient } from '../../../src/modules/os/core-client.ts'
import { enforceDeadline, observeActivation } from '../../../src/modules/os/wake-deadline.ts'
import { iso } from '../../../src/modules/os/contracts.ts'
import type { State, OsTarget } from '../../../src/modules/os/index.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-os-wake-')), config = osFixture(root)
  config.identity = { userId: '2', secret: 'isolated-test-secret', coreBaseUrl: 'http://127.0.0.1:1' }
  const session = randomUUID(), directory = path.join(config.wakeDir, 'sessions', session), calls: State[] = []
  const request = (revision: number, extra: State = {}) => saveState(path.join(directory, 'schedule_requests', `${revision}.json`), {
    schema_version: 'self-awake.schedule.v2', scope_kind: 'session_task', session_id: session, revision, requested_at: iso(),
    action: 'schedule', next_wake_at: iso(0), job_id: randomUUID(), ...extra })
  const target: OsTarget = { ready: () => true, async admitReminder() { return { memoId: 1 } }, async reminderDelivery() { return null },
    async run(input) { calls.push(input as State); return { accepted: true, job_id: 'accepted-job' } },
    async status() { return { status: 'completed' } } }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, config, session, directory, calls, request, target, state: () => readState(path.join(directory, 'state.json')) }
}

test('due one-shot wakes admit once, persist across reconstruction and finish without a watchdog loop', async t => {
  const f = fixture(t), now = Date.now()
  f.request(1)
  await new WakeSession(f.config, f.session, f.target).tick(now)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.scheduled_job_id.length, 36)
  await new WakeSession(f.config, f.session, f.target).tick(now + 2000)
  assert.equal(f.state().enabled, false)
  await new WakeSession(f.config, f.session, f.target).tick(now + 86400000)
  assert.equal(f.calls.length, 1)
})

test('a lost admission reply reuses the exact durable event and payload after restart', async t => {
  const f = fixture(t), now = Date.now()
  let first = true
  f.target.run = async value => { f.calls.push(value as State); if (first) { first = false; throw new Error('reply lost') }; return { accepted: true, job_id: 'same-job' } }
  f.request(1)
  await new WakeSession(f.config, f.session, f.target).tick(now)
  assert.ok(f.state().pending_submission)
  await new WakeSession(f.config, f.session, f.target).tick(now + 61000)
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], f.calls[0]); assert.equal(f.state().pending_submission, null)
})

test('replacement and cancellation acknowledge the highest revision before removing requests', async t => {
  const f = fixture(t)
  f.request(1); f.request(2, { action: 'cancel', job_id: null, next_wake_at: null })
  await new WakeSession(f.config, f.session, f.target).tick()
  assert.equal(f.calls.length, 0); assert.equal(f.state().revision, 2); assert.equal(f.state().enabled, false)
  assert.equal(existsSync(path.join(f.directory, 'schedule_requests', '2.json')), false)
})

test('normal publications with a null legacy handoff do not block later role schedules', async t => {
  const f = fixture(t), now = Date.now(), job = randomUUID()
  // The Agent publisher emits null for plans that were never legacy handoffs.
  // An older pending publication must not poison validation of the newer plan.
  f.request(1, { scope_kind: 'role', legacy_request_id: null })
  f.request(2, { scope_kind: 'role', legacy_request_id: null, job_id: job })
  await new WakeSession(f.config, f.session, f.target).tick(now)
  assert.equal(f.state().revision, 2)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.scheduled_job_id, job)
  assert.equal(existsSync(path.join(f.directory, 'schedule_requests', '1.json')), false)
  assert.equal(existsSync(path.join(f.directory, 'schedule_requests', '2.json')), false)
  assert.equal(existsSync(path.join(f.config.wakeDir, 'session_handoffs')), false)
})

test('unknown delivery outcomes retain the original slot and never re-admit', async t => {
  const f = fixture(t), now = Date.now()
  f.target.status = async () => ({ status: 'unknown' })
  f.request(1)
  await new WakeSession(f.config, f.session, f.target).tick(now)
  await new WakeSession(f.config, f.session, f.target).tick(now + 86400000)
  assert.equal(f.calls.length, 1); assert.equal(f.state().last_agent_async_status, 'pending')
})

test('one failed session cannot prevent another session from advancing', async t => {
  const f = fixture(t), other = randomUUID()
  saveState(path.join(f.config.wakeDir, 'sessions', other, 'state.json'), { session_id: f.session })
  f.request(1)
  const results = await Promise.allSettled([new WakeSession(f.config, other, f.target).tick(), new WakeSession(f.config, f.session, f.target).tick()])
  assert.equal(results[0]!.status, 'rejected'); assert.equal(results[1]!.status, 'fulfilled'); assert.equal(f.calls.length, 1)
})

test('watchdog keeps twelve and twenty-four hour deadlines and preserves retry backoff', t => {
  const f = fixture(t), now = Date.now(), state: State = {}
  enforceDeadline(state, now)
  assert.equal(Date.parse(state.next_wake_at), now + 12 * 3600000)
  state.next_wake_source = 'tool'; state.next_wake_at = iso(now + 48 * 3600000)
  enforceDeadline(state, now + 1000)
  assert.equal(Date.parse(state.next_wake_at), now + 24 * 3600000)
  state.next_wake_source = 'retry'; state.next_wake_at = iso(now + 72 * 3600000)
  saveState(path.join(f.directory, 'agent_activation.json'), { started_at: iso(now + 500), run_id: 'actual-run' })
  observeActivation(state, f.directory, now + 2000)
  assert.equal(Date.parse(state.next_wake_at), now + 72 * 3600000)
})

test('legacy root yields to a paused role clock and never re-enables its scope', async t => {
  const f = fixture(t)
  saveState(path.join(f.config.wakeDir, 'state.json'), { delegated_role_session_id: f.session, next_wake_at: iso(0) })
  saveState(path.join(f.directory, 'state.json'), { session_id: f.session, scope_kind: 'role', enabled: false })
  await new WakeRoot(f.config, f.target).tick()
  assert.equal(f.calls.length, 0); assert.equal(f.state().enabled, false)
})

test('session coordinator publishes a live protocol lease and removes it on shutdown', async t => {
  const f = fixture(t), core = new OsCoreClient(f.config.identity), scheduler = new OsScheduler(f.config, f.target, core)
  scheduler.start()
  const capability = path.join(f.config.wakeDir, 'session-protocol.json')
  assert.equal(readState(capability).owner, 'eden-agent-ts'); assert.ok(readState(capability).expiresAt > Date.now())
  core.close(); await scheduler.close()
  assert.equal(existsSync(capability), false)
})
