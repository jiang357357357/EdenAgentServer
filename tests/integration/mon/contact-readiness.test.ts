import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { MonClient } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { deliverOwnerQq, ownerQqTarget } from '../../../src/modules/mon/qq-contact.ts'
import { qqChannelReadiness } from '../../../src/modules/mon/qq-bot-readiness.ts'

async function fixture() {
  const database = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(database, 'mon')
  const session = sessions.create('Contact readiness fixture')
  const state = { online: false as boolean | undefined, botStatus: 'online', botId: '42', discoveryStatus: 200,
    posts: 0, status: 200, body: { success: true } as object }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/devices/qq_bot/management/') {
      response.end(JSON.stringify({ data: { bot_id: 42, access: { botcore_connected: state.online },
        default_send_target: { target_type: 'user', target_qq_number: '123456' } } })); return
    }
    if (request.url === '/api/devices/qq_bot/?summary=true') {
      response.statusCode = state.discoveryStatus
      response.end(JSON.stringify({ data: [{ id: state.botId, status: state.botStatus }] })); return
    }
    state.posts++; for await (const _chunk of request) { /* Drain this private fixture's request. */ }
    response.statusCode = state.status; response.end(JSON.stringify(state.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new MonClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'synthetic-token')
  const send = (id = randomUUID()) => deliverOwnerQq(database, client, session.id,
    { requestId: id, message: 'synthetic message' }, new AbortController().signal)
  return { database, state, client, send, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); database.close()
  } }
}

test('configured but offline or unknown QQ connections are not advertised as deliverable and never POST', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (const online of [false, undefined]) {
    f.state.online = online
    const selected = await ownerQqTarget(f.client, new AbortController().signal)
    const readiness = qqChannelReadiness({ status: 'fulfilled', value: selected }) as { available: boolean; configured: boolean; readiness: string }
    assert.equal(readiness.configured, true); assert.equal(readiness.available, false)
    assert.equal(readiness.readiness, online === false ? 'offline' : 'unknown')
    await assert.rejects(f.send(), /QQBot.*未在线|在线状态未确认/)
  }
  assert.equal(f.state.posts, 0)
  assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM mon_contact_deliveries').get()?.n, 0)
})

test('confirmed acceptance is retained when the bot later goes offline and the request is not resent', async t => {
  const f = await fixture(); t.after(() => f.close()); f.state.online = true
  const id = randomUUID(), first = await f.send(id) as { status: string }
  assert.equal(first.status, 'accepted')
  f.state.online = false
  const duplicate = await f.send(id) as { alreadyAccepted: boolean }
  assert.equal(duplicate.alreadyAccepted, true); assert.equal(f.state.posts, 1)
})

test('connected BotCore cannot mask an offline, absent or unconfirmed selected QQ account', async t => {
  const f = await fixture(); t.after(() => f.close()); f.state.online = true
  for (const state of [{ botStatus: 'offline' }, { botStatus: 'error' }, { botStatus: 'unknown' },
    { botStatus: 'online', botId: '43' }, { botId: '42', discoveryStatus: 503 }]) {
    Object.assign(f.state, state)
    const selected = await ownerQqTarget(f.client, new AbortController().signal)
    assert.notEqual(selected.online, true)
    const result = qqChannelReadiness({ status: 'fulfilled', value: selected }) as { configured: boolean; available: boolean }
    assert.equal(result.configured, true); assert.equal(result.available, false)
    await assert.rejects(f.send(), /未在线|在线状态未确认/)
  }
  assert.equal(f.state.posts, 0)
})

test('Core HTTP and business rejections retain their reason without secrets and cannot be resent', async t => {
  const f = await fixture(); t.after(() => f.close()); f.state.online = true
  for (const status of [400, 200]) {
    const id = randomUUID()
    f.state.status = status
    f.state.body = { success: false, message: 'QQBot 未在线；token=super-private-fixture-token', token: 'separate-private-value' }
    await assert.rejects(f.send(id), error => {
      assert.match(String(error), /QQBot 未在线/); assert.doesNotMatch(String(error), /super-private|separate-private/); return true
    })
    const row = f.database.connection.prepare('SELECT state,error FROM mon_contact_deliveries WHERE request_id=?').get(id)
    assert.equal(row?.state, 'failed'); assert.match(String(row?.error), /QQBot 未在线/)
    assert.doesNotMatch(String(row?.error), /super-private|separate-private/)
    const posts = f.state.posts
    await assert.rejects(f.send(id), /previously rejected/); assert.equal(f.state.posts, posts)
  }
})
