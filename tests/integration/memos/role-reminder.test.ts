import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { roleReminderFixture, email, qq } from './role-reminder-fixture.ts'

test('QQ-origin reminder wakes the role, which selects email and writes its own message', async t => {
  const f = await roleReminderFixture(t)
  const memo = f.create(), job = f.stage()
  assert.equal(f.writes.length, 0)
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'completed')
  assert.deepEqual(f.writes.map(write => write.channel), ['email'])
  assert.equal(f.writes[0]!.body.content, email.input.message)
  assert.ok(f.memos.read(memo.id).lastTriggeredAt)
  assert.match(f.prompts[0]!, /自主选择/)
})

test('App-origin reminder also allows the role to contact through email', async t => {
  const f = await roleReminderFixture(t, 'app')
  f.create(); const job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'completed')
  assert.equal(f.writes[0]?.channel, 'email')
})

test('group-origin reminders have the same role choice and permission checks as private reminders', async t => {
  const f = await roleReminderFixture(t, 'qq', true)
  f.create(); const job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'completed')
  assert.deepEqual(f.writes.map(write => write.channel), ['email'])
})

test('after a definite rejection the role can choose a different authorized channel', async t => {
  const f = await roleReminderFixture(t)
  f.plans.rejectEmail = true; f.plans.steps = [email, qq]
  f.create(); const job = f.stage(); await f.finish()
  assert.deepEqual(f.writes.map(write => write.channel), ['email', 'qq'])
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('a closed QQ conversation can wake its role and send without reopening the chat', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = [qq]; f.create()
  f.database.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(f.session.id)
  const job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'completed', JSON.stringify(f.database.connection.prepare('SELECT * FROM memo_delivery_effects').all()))
  assert.equal(f.repository.read(f.session.id).status, 'closed')
  assert.equal(f.writes[0]?.body.action, 'send_private_msg')
  assert.throws(() => f.napcat.target(f.session.id, undefined, 'forged-or-completed-turn'), /active session/)
})

test('plain model text and the inbox record cannot mark a reminder delivered', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = []; const memo = f.create(), job = f.stage(); await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'failed')
  assert.match(f.jobs.read(job.id).error!, /没有取得实际通信回执/)
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
  assert.equal(f.notifications.list().length, 1)
})

test('an explicit QQ choice blocks email while retaining the role-selected QQ expression', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = [email, qq]; f.create({ delivery: { channel: 'qq' } })
  const job = f.stage(); await f.finish()
  assert.deepEqual(f.writes.map(write => write.channel), ['qq'])
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('an accepted communication blocks a second channel notification in the same role turn', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = [email, qq]; f.create(); const job = f.stage(); await f.finish()
  assert.deepEqual(f.writes.map(write => write.channel), ['email'])
  assert.equal(f.jobs.read(job.id).state, 'completed')
})

test('normal permission denial remains effective for scheduled role contact', async t => {
  const f = await roleReminderFixture(t)
  f.permissions.setMode('restricted'); f.permissions.setQqMode('123456', '654321', 'restricted')
  const memo = f.create(), job = f.stage(); await f.finish()
  assert.equal(f.writes.length, 0)
  assert.equal(f.jobs.read(job.id).state, 'failed')
  assert.equal(f.memos.read(memo.id).lastTriggeredAt, null)
})

test('cancelling before the decision sends nothing and leaves the occurrence unadvanced', async t => {
  const f = await roleReminderFixture(t)
  const memo = f.create(), job = f.stage()
  f.memos.update(memo.id, { status: 'cancelled' })
  await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'cancelled')
  assert.equal(f.writes.length, 0)
})

test('editing a memo during communication approval prevents the stale content from being sent', async t => {
  const f = await roleReminderFixture(t)
  const memo = f.create(), job = f.stage()
  const original = f.permissions.request.bind(f.permissions)
  f.permissions.request = async (...args) => {
    f.memos.update(memo.id, { content: 'changed during approval' })
    await original(...args)
  }
  await f.finish()
  assert.equal(f.writes.length, 0)
  assert.equal(f.jobs.read(job.id).state, 'failed')
})

test('the live scheduler wakes the role without an inbound message', async t => {
  const f = await roleReminderFixture(t)
  f.create(); f.scheduler.start(); f.service.start()
  const deadline = Date.now() + 15000
  while (!f.writes.length && Date.now() < deadline) await delay(20)
  await f.sessions.waitForIdle(f.session.id); await f.service.drain()
  assert.equal(f.writes.length, 1)
  assert.equal(f.jobs.list({})[0]!.state, 'completed')
})

test('a QQ role can choose App notification and wait for its display receipt', async t => {
  const f = await roleReminderFixture(t)
  f.plans.steps = [{ name: 'show_desktop_reminder', input: { title: '角色提醒', message: '老师，时间到了。' } }]
  f.create(); const job = f.stage()
  f.database.connection.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(f.session.id)
  await f.finish()
  assert.equal(f.jobs.read(job.id).state, 'dispatched')
  f.desktop.transition(f.desktop.list({})[0]!.id, 'displayed'); await f.service.drain()
  assert.equal(f.jobs.read(job.id).state, 'completed')
  assert.equal(f.writes.length, 0)
})
