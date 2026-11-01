import assert from 'node:assert/strict'
import test from 'node:test'
import { roleReminderFixture, email, qq } from './role-reminder-fixture.ts'
import { SessionService } from '../../../src/modules/sessions/index.ts'
import { MemoDeliveryService } from '../../../src/modules/memos/index.ts'

test('lost receipt blocks channel fallback and automatic replay, while explicit review can confirm receipt', async t => {
  const f = await roleReminderFixture(t)
  f.plans.loseReceipt = true; f.plans.steps = [email, qq]
  const memo = f.create(), job = f.stage(); await f.finish()
  assert.equal(f.writes.length, 1)
  assert.equal(f.jobs.read(job.id).state, 'unknown')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  f.deliveries.recover(); f.jobs.recover(); f.memos.recoverSchedules(); await f.service.drain()
  assert.equal(f.writes.length, 1)
  const current = f.jobs.read(job.id)
  f.recovery.resolveOutcome(job.id, current.updatedAt, 'completed', '用户核对邮箱，确认已经收到')
  assert.equal(f.jobs.read(job.id).state, 'completed')
  assert.ok(f.memos.read(memo.id).lastTriggeredAt)
})

test('a malformed QQ success without message ID stays unknown', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = [qq]; f.plans.malformed = true
  const memo = f.create(), job = f.stage(); await f.finish()
  assert.equal(f.writes.length, 1)
  assert.equal(f.jobs.read(job.id).state, 'unknown')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
})

test('an explicit retry after definite rejection wakes the role again and advances recurrence once', async t => {
  const f = await roleReminderFixture(t)
  f.plans.reject = true; const memo = f.create({ repeatRule: 'daily' }), job = f.stage(); await f.finish()
  const failed = f.jobs.read(job.id)
  assert.equal(failed.state, 'failed')
  const replay = f.recovery.resubmit(job.id, failed.updatedAt, '核实未送达，明确补发')
  const claimed = f.jobs.claim()!; assert.equal(claimed.id, replay.id); f.recovery.dispatch(claimed)
  f.plans.reject = false; await f.finish()
  assert.equal(f.jobs.read(replay.id).state, 'completed')
  assert.ok(f.memos.read(memo.id).remindAt! > Date.now())
  assert.equal(f.writes.length, 2)
})

test('confirmed redelivery of an accepted reminder does not advance the schedule twice', async t => {
  const f = await roleReminderFixture(t)
  const memo = f.create({ repeatRule: 'daily' }), job = f.stage(); await f.finish()
  const due = f.memos.read(memo.id).remindAt, original = f.jobs.read(job.id)
  const replay = f.recovery.resubmit(job.id, original.updatedAt, '明确再次发送这条历史提醒')
  assert.equal(f.jobs.claim()?.id, replay.id); f.recovery.dispatch(f.jobs.read(replay.id)); await f.finish()
  assert.equal(f.jobs.read(replay.id).state, 'completed')
  assert.equal(f.memos.read(memo.id).remindAt, due)
  assert.equal(f.writes.length, 2)
})

test('desktop creation waits for the actual display acknowledgement', async t => {
  const f = await roleReminderFixture(t, 'app')
  f.plans.steps = [{ name: 'show_desktop_reminder', input: { title: '角色提醒', message: '老师，时间到了。' } }]
  const memo = f.create({ delivery: { channel: 'app' } }), job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'dispatched')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  const reminder = f.desktop.list({})[0]!
  f.desktop.transition(reminder.id, 'displayed'); await f.service.drain()
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('a queued device command is not accepted until the device reports success', async t => {
  const f = await roleReminderFixture(t, 'app')
  f.plans.steps = [{ name: 'control_esp32_device', input: { deviceId: 1, action: 'notification.show', text: '老师，时间到了。' } }]
  const memo = f.create({ delivery: { channel: 'device' } }), job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'dispatched')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  f.plans.deviceStatus = 'succeeded'; await f.service.drain()
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('an interrupted legacy fixed-channel send becomes unknown and is never delegated for automatic resend', async t => {
  const f = await roleReminderFixture(t)
  f.create(); const job = f.stage()
  f.database.connection.prepare("UPDATE memo_channel_deliveries SET state='sending' WHERE job_id=?").run(job.id)
  f.deliveries.recover(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'unknown')
  assert.equal(f.writes.length, 0)
})

test('a decision claim interrupted before input admission can be recovered safely', async t => {
  const f = await roleReminderFixture(t)
  f.create(); const job = f.stage(); f.deliveries.claim(); f.deliveries.recover(); await f.finish()
  assert.equal(f.writes.length, 1)
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('an old metadata channel cannot override the explicit delivery policy', async t => {
  const f = await roleReminderFixture(t)
  f.create({ metadata: { delivery: { channel: 'qq' }, target: { channel: 'qq' } } })
  const job = f.stage(); await f.finish()
  assert.deepEqual(f.writes.map(write => write.channel), ['email'])
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('missing model binding defers the decision without a host-selected fallback or a false receipt', async t => {
  const f = await roleReminderFixture(t)
  const sessions = new SessionService(f.repository, undefined)
  const service = new MemoDeliveryService(f.deliveries, sessions, f.effects)
  t.after(async () => { await service.close(); await sessions.close() })
  const memo = f.create(), job = f.stage(); await service.drain()
  assert.equal(f.jobs.read(job.id).state, 'dispatched')
  assert.match(f.jobs.read(job.id).error!, /No model configured/)
  assert.equal(f.database.connection.prepare('SELECT state FROM memo_channel_deliveries').get()?.state, 'queued')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  assert.equal(f.writes.length, 0)
})
