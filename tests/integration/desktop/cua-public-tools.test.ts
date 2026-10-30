import assert from 'node:assert/strict'
import test from 'node:test'
import { cuaToolNames } from '@eden/api'
import { desktopFixture, tick } from './fixture.ts'
import { DesktopError } from '../../../src/modules/desktop/contracts.ts'
import { desktopTools } from '../../../src/modules/desktop/index.ts'
import { modelTool } from '../../../src/modules/tool-results/index.ts'
import { randomUUID } from 'node:crypto'

test('all 56 public tools register with host-owned snapshots and preserve user JavaScript results', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const names = a.tools.filter(tool => tool.name.startsWith('cua_')).map(tool => tool.name).sort()
  assert.deepEqual(names, cuaToolNames.map(name => `cua_${name}`).sort())
  const click = a.tools.find(tool => tool.name === 'cua_click')!
  assert.equal(Object.hasOwn(click.parameters.properties as object, 'snapshot_id'), false)
  const payload = { session: 'user-label', pid: 71, snapshot_id: 'business-content', result: { request_id: 'user-data' } }
  f.driver.native = async () => ({ status: 'delivered', message: 'ok', text: '', images: [], structuredJson: JSON.stringify(payload) })
  const value = await a.call('cua_page', { action: 'execute_javascript', javascript: 'return data' })
  assert.deepEqual(value.data, payload)
})

test('native references also stay within the current turn and acting role', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  f.driver.native = async () => ({ status: 'delivered', message: 'ok', text: '', images: [],
    structuredJson: JSON.stringify({ windows: [{ pid: 71, window_id: 99 }] }) })
  const first = (await a.call('cua_list_windows', {})).data.windows[0]
  for (const [turnId, actor] of [[randomUUID(), undefined], [a.turnId, 'other-role']] as const) {
    const tool = desktopTools(a.service, a.permissions, a.session.id, turnId, actor).map(modelTool).find(tool => tool.name === 'cua_get_window_state')!
    await assert.rejects(tool.execute({ pid: first.pid, window_id: first.window_id }, { callId: randomUUID(), signal: new AbortController().signal }), /当前会话/)
  }
})

test('native refs bind exact 64-bit handles, snapshots and Eden sessions; clearing prevents stale input', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account('mon'), b = f.account('local')
  a.permissions.setMode('full_access'); b.permissions.setMode('full_access')
  const calls: { name: string; args: Record<string, unknown> }[] = []
  f.driver.native = async (name, args) => {
    calls.push({ name, args })
    const data = name === 'list_windows' ? { windows: [{ pid: 71, window_id: '18446744073709551615', title: 'Fixture' }] }
      : name === 'get_window_state' ? { pid: 71, window_id: '18446744073709551615', snapshot_id: 's12345678', elements: [{ element_index: 3, element_token: 's12345678:3' }] } : {}
    return { status: 'delivered', message: 'ok', text: '', images: [], structuredJson: JSON.stringify(data) }
  }
  const first = (await a.call('cua_list_windows', {})).data.windows[0]
  const other = (await b.call('cua_list_windows', {})).data.windows[0]
  assert.notEqual(first.pid, 71); assert.notEqual(first.window_id, other.window_id)
  await assert.rejects(b.call('cua_get_window_state', { pid: first.pid, window_id: first.window_id }), /当前会话/)
  const state = await a.call('cua_get_window_state', { pid: first.pid, window_id: first.window_id })
  assert.equal(state.data.snapshot_id, undefined)
  await a.call('cua_click', { pid: first.pid, window_id: first.window_id, element_index: 3 })
  assert.deepEqual(calls.at(-1), { name: 'click', args: { pid: 71, window_id: '18446744073709551615', element_index: 3, snapshot_id: 's12345678' } })
  await a.service.control('stop'); await a.service.control('resume')
  const before = calls.length
  await assert.rejects(a.call('cua_click', { pid: first.pid, window_id: first.window_id, element_index: 3 }), /当前会话/)
  assert.equal(calls.length, before)
})

test('denied clipboard, browser upload, recording and config calls never reach the driver', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); let effects = 0
  f.driver.native = async () => { effects++; return { status: 'delivered', message: 'ok', text: '', images: [] } }
  // Accept the task grant once; individual sensitive calls still require their own approval.
  const list = a.call('cua_list_apps', {}); await tick()
  a.permissions.resolve(a.permissions.list().find(request => request.state === 'pending')!.id, true); await list
  for (const [name, input] of [
    ['cua_clipboard_write', { text: 'fixture' }], ['cua_browser_set_input_files', { target_id: 'browser', tab_id: 'tab', files: ['fixture.txt'], ref: 'file-input' }],
    ['cua_start_recording', { output_dir: 'fixture' }], ['cua_set_config', { key: 'max_image_dimension', value: 900 }],
    ['cua_replay_trajectory', { dir: 'fixture' }], ['cua_install_ffmpeg', { confirm: true }],
  ] as const) {
    const pending = a.call(name, input), rejected = assert.rejects(pending, /denied/)
    await tick()
    const approval = a.permissions.list().find(request => request.state === 'pending')!
    assert.ok(approval, name)
    a.permissions.resolve(approval.id, false); await rejected
  }
  assert.equal(effects, 1)
})

test('browser, clipboard, recording, config and desktop drag delegate without rewriting business arguments', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const calls: { name: string; args: Record<string, unknown> }[] = []
  f.driver.native = async (name, args) => {
    calls.push({ name, args }); return { status: 'delivered', message: 'ok', text: 'result', images: [] }
  }
  const cases = [
    ['browser_navigate', { url: 'https://example.test', target_id: 'browser', tab_id: 'business-tab' }],
    ['clipboard_write', { text: 'user content pid=71' }], ['start_recording', { output_dir: 'fixture', record_video: false }],
    ['stop_recording', {}], ['get_config', {}], ['set_config', { key: 'value', value: { pid: 72, snapshot_id: 'user-data' } }],
    ['drag', { scope: 'desktop', delivery_mode: 'foreground', from_x: 1, from_y: 2, to_x: 4, to_y: 6 }],
  ] as const
  for (const [name, args] of cases) {
    await a.call(`cua_${name}`, args)
    assert.deepEqual(calls.at(-1), { name, args })
  }
})

test('native refusal and unknown effects keep their outcomes; release closes a scoped driver', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  let releases = 0
  f.driver.release = async () => { releases++ }
  f.driver.native = async () => ({ status: 'unknown', effect: 'partial', route: 'global_input', message: 'partial', text: '', images: [] })
  const result = await a.call('cua_hotkey', { scope: 'desktop', keys: ['ctrl', 'enter'] })
  assert.equal(result.status, 'unknown'); assert.equal(result.effect, 'partial')
  f.driver.native = async () => { throw new DesktopError('cancelled', 'CUA_CANCELLED', 'unknown') }
  await assert.rejects(a.call('cua_hotkey', { scope: 'desktop', keys: ['ctrl', 'enter'] }), (error: DesktopError) => error.toolOutcome === 'unknown')
  await a.service.release(a.session.id); assert.equal(releases, 1)
})
