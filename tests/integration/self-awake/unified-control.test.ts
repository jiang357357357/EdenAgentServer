import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readState, saveState } from '../../../src/modules/os/index.ts'
import { unifiedControlFixture, waitUntil } from './unified-control-fixture.ts'

test('a saved UI enable overrides legacy ENABLED=false and the real clock executes the exact published plan', async t => {
  const f = unifiedControlFixture(t)
  f.enabled(true); const job = f.plan(); f.scheduler.start()
  await waitUntil(() => f.lease().state === 'ready', 'account scheduler must become ready')
  f.awake.timerPublication.publish()
  await waitUntil(() => f.calls.length === 1, 'the role plan must be delivered by the running interval')
  assert.equal(f.config.selfAwakeEnabled, false)
  assert.equal(f.calls[0]!.scheduled_job_id, job.id)
  assert.equal(f.lease().accountKey, f.account.key)
  assert.equal(f.awake.controlState().scheduler.status, 'ready')
})

test('paused self-awake renews its lease and leaves the independent memo coordinator running', async t => {
  const f = unifiedControlFixture(t)
  f.scheduler.start()
  await waitUntil(() => f.lease().state === 'paused', 'legacy false is imported on first start')
  const expiresAt = f.lease().expiresAt
  await waitUntil(() => f.lease().expiresAt > expiresAt, 'pause must keep the capability heartbeat alive')
  assert.equal(f.calls.length, 0)
  assert.ok(f.memoPolls > 0)
  assert.equal(f.scheduler.status, 'paused')
  assert.equal(f.awake.controlState().schedule?.status, 'disabled')
})

test('UI enable starts a paused clock without editing config or restarting Agent', async t => {
  const f = unifiedControlFixture(t)
  f.scheduler.start(); await waitUntil(() => f.lease().state === 'paused', 'paused account must be visible')
  const job = f.plan(); f.awake.timerPublication.publish()
  await delay(1050); assert.equal(f.calls.length, 0)
  f.enabled(true)
  await waitUntil(() => f.calls.length === 1, 'the same saved plan must resume')
  assert.equal(f.calls[0]!.scheduled_job_id, job.id)
  await delay(1100); assert.equal(f.calls.length, 1, 'one accepted plan must not be submitted twice')
})

test('pause and restart preserve the scheduled job and resume it once under database control', async t => {
  const f = unifiedControlFixture(t)
  f.enabled(true); f.scheduler.start(); await waitUntil(() => f.lease().state === 'ready', 'scheduler must become ready')
  const job = f.plan(); f.enabled(false)
  await waitUntil(() => f.lease().state === 'paused', 'clock must observe the database pause')
  await f.restart(); await waitUntil(() => f.lease().state === 'paused', 'restart must preserve the account pause')
  assert.equal(f.jobs.read(job.id).state, 'queued'); assert.equal(f.calls.length, 0)
  f.enabled(true); await waitUntil(() => f.calls.length === 1, 'original plan must resume after restart')
  assert.equal(f.calls[0]!.scheduled_job_id, job.id)
})

test('restart cannot replace an existing account enable with the old installation disable', async t => {
  const f = unifiedControlFixture(t)
  f.enabled(true); f.scheduler.start(); await waitUntil(() => f.lease().state === 'ready', 'scheduler must start')
  await f.restart(); await waitUntil(() => f.lease().state === 'ready', 'saved enable must survive restart')
  assert.equal(f.awake.control.read().enabled, true)
  assert.equal(f.config.selfAwakeEnabled, false)
  assert.equal(f.lease().controlUpdatedAt, f.awake.control.read().updatedAt)
})

test('startup waits for its own account readiness without claiming a failed protocol', async t => {
  const f = unifiedControlFixture(t)
  f.enabled(true); f.setReady(false); f.scheduler.start()
  assert.equal(f.awake.controlState().scheduler.status, 'starting')
  assert.equal(f.calls.length, 0)
  f.setReady(true); await waitUntil(() => f.lease().state === 'ready', 'scheduler must recover when the owner account is ready')
  assert.equal(readState(f.stateFile).last_error ?? '', '')
})

test('an old root state enabled=false cannot veto the authoritative account enable', async t => {
  const f = unifiedControlFixture(t)
  saveState(f.stateFile, { enabled: false, next_wake_at: new Date(Date.now() - 1000).toISOString() })
  f.enabled(true); f.scheduler.start()
  await waitUntil(() => f.calls.length === 1, 'legacy root pause must not remain a hidden third switch')
  assert.equal(readState(f.stateFile).enabled, true)
  assert.equal(f.calls[0]!.context.type, 'scheduled')
  assert.equal(f.config.startupWakeEnabled, false)
})

test('an independent Core memo failure does not stop self-awake or mislabel its heartbeat', async t => {
  const f = unifiedControlFixture(t)
  f.failMemos(); f.enabled(true); const job = f.plan(); f.scheduler.start()
  await waitUntil(() => f.lease().state === 'ready', 'self-awake lease must remain healthy')
  assert.match(f.scheduler.fault!, /memo endpoint unavailable/)
  assert.equal(f.scheduler.status, 'ready')
  f.awake.timerPublication.publish()
  await waitUntil(() => f.calls.length === 1, 'self-awake must continue despite the independent memo failure')
  assert.equal(f.calls[0]!.scheduled_job_id, job.id)
})
