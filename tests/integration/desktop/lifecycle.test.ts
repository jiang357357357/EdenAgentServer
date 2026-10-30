import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DesktopOperations } from '../../../src/modules/desktop/operation-repository.ts'
import { desktopFixture } from './fixture.ts'

test('releasing a session discards its desktop references', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  await a.service.release(a.session.id)
  await assert.rejects(a.call('desktop_observe', { window: ref }), /当前会话/)
  assert.equal(f.calls.length, 0)
})

test('session release cancels a request still preparing the native driver', async t => {
  let ready!: () => void, finish!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const f = await desktopFixture({ initialize: async () => { ready(); await pending } })
  t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const request = a.call('desktop_list_windows', {})
  const rejected = assert.rejects(request, /准备期间已取消/)
  await preparing
  await a.service.release(a.session.id)
  finish(); await rejected
  assert.equal(f.calls.length, 0)
  assert.equal((await a.call('desktop_list_windows', {})).windows.length, 2)
})

test('QQ and self-awake sessions do not inherit local desktop authorization', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account('mon'); a.permissions.setMode('full_access')
  const qq = a.sessions.create('QQ fixture', [{ assistantId: 1 }], null, { purpose: 'user_chat', sourceChannel: 'qq' })
  const awake = a.sessions.create('Awake fixture', [{ assistantId: 1 }], { sessionPurpose: 'self_awake' })
  for (const sessionId of [qq.id, awake.id]) await assert.rejects(a.service.authorize(a.permissions, {
    sessionId, turnId: randomUUID(), callId: randomUUID(), signal: new AbortController().signal,
  }), /不继承|没有本机桌面/)
  assert.equal(a.permissions.list().length, 0)
  assert.equal(f.calls.length, 0)
})

test('stop and resume cannot revive an operation still preparing the driver', async t => {
  let ready!: () => void, finish!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const f = await desktopFixture({ initialize: async () => { ready(); await pending } })
  t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const request = a.call('desktop_list_windows', {})
  const rejected = assert.rejects(request, /准备期间已取消/)
  await preparing
  await a.service.control('stop'); await a.service.control('resume')
  finish(); await rejected
  assert.equal(f.calls.length, 0)
  assert.equal((await a.call('desktop_list_windows', {})).windows.length, 2)
})

test('host recovery records interrupted input as unknown and refuses replay', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(), operations = new DesktopOperations(a.database)
  const input = { id: randomUUID(), sessionId: a.session.id, turnId: a.turnId, actor: 'root', action: 'desktop_type', request: { text: 'fixture' } }
  operations.begin(input)
  const recovered = new DesktopOperations(a.database)
  const row = a.database.connection.prepare('SELECT state,error FROM desktop_operations WHERE id=?').get(input.id)
  assert.equal(row?.state, 'unknown'); assert.match(String(row?.error), /restarted/)
  assert.throws(() => recovered.begin(input), /不能重放/)
})

test('oversized UTF-8 requests fail before transmission and leave the connection usable', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  await assert.rejects(a.call('desktop_launch', { application: 'fixture', arguments: Array(20).fill('中'.repeat(4096)) }), /指令过长/)
  assert.equal(f.calls.length, 0)
  assert.equal((await a.call('desktop_list_windows', {})).windows.length, 2)
  const row = a.database.connection.prepare("SELECT state FROM desktop_operations WHERE action='desktop_launch'").get()
  assert.equal(row?.state, 'failed')
})

test('absolute Windows launch paths use the native path field', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const application = 'C:\\Program Files\\Eden Fixture\\fixture.exe'
  await a.call('desktop_launch', { application, arguments: ['one argument'] })
  assert.deepEqual(f.calls[0], { name: 'launch_app', args: { path: application, additional_arguments: ['one argument'] } })
})
