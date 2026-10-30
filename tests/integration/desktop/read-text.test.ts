import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeElement } from '../../../src/modules/desktop/contracts.ts'
import { desktopFixture } from './fixture.ts'
import { tick } from './fixture.ts'

test('text read fetches current value without images, renews references and preserves task authorization', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver), options: unknown[] = []
  f.driver.observe = async (w, s, option) => {
    options.push(option)
    const o = await observe(w, s)
    return { ...o, elements: [{ ...o.elements[0]!, valueAvailable: true }] }
  }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const before = await a.call('desktop_observe', { window: ref })
  f.values.set('1', 'current text')
  const result = await a.call('desktop_read_text', { window: ref, element: before.elements[0].element })
  assert.equal(result.text, 'current text'); assert.equal(result.source, 'value'); assert.equal(result.complete, true)
  assert.equal(result.status, 'read'); assert.equal(result.images, undefined); assert.equal(result.elements, undefined)
  assert.notEqual(result.element, before.elements[0].element); assert.deepEqual(options[1], { screenshot: false, text: true })
  assert.equal(f.calls.length, 0); assert.equal(a.permissions.list().length, 1)
  await assert.rejects(a.call('desktop_click', { window: ref, element: before.elements[0].element }), /已失效/)
  await assert.rejects(a.call('desktop_click', { window: ref, x: 10, y: 10 }), /截图未取得/)
  await a.call('desktop_type', { window: ref, element: result.element, text: 'next' })
  assert.equal(f.calls.length, 1)
})

test('contenteditable reads only its own text descendants, including observation-only nodes', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  const entry = (index: string, parent: string | undefined, role: string, label: string): NativeElement => ({
    index, ...(parent ? { parent } : {}), token: index === '2' ? '' : `private-${index}`, role, label,
    value: '', valueAvailable: false, enabled: true, actions: [],
  })
  f.driver.observe = async (w, s) => ({ ...await observe(w, s), elements: [
    entry('0', undefined, 'Pane', 'Chat'), entry('1', '0', 'Document', 'Composer'),
    entry('2', '1', 'Text', f.values.get('1') ?? 'inside'), entry('3', '0', 'Text', 'unrelated message'),
  ] })
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const before = await a.call('desktop_observe', { window: ref })
  const result = await a.call('desktop_read_text', { window: ref, element: before.elements[1].element })
  assert.equal(result.text, 'inside'); assert.equal(result.source, 'text_descendants'); assert.equal(result.complete, true)
  assert.equal(JSON.stringify(result).includes('unrelated message'), false)
  assert.deepEqual(result.locator.ancestors, [{ role: 'Pane', label: 'Chat' }])
  await assert.rejects(a.call('desktop_click', { window: ref, element: before.elements[2].element }), /已失效/)
  const fresh = await a.call('desktop_observe', { window: ref })
  await assert.rejects(a.call('desktop_click', { window: ref, element: fresh.elements[2].element }), /只有观察数据/)
  assert.equal(f.calls.length, 0)
})

test('stable locators resolve after snapshots, reject ambiguity and distinguish missing text from empty value', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  let duplicate = false, available = true
  f.driver.observe = async (w, s) => {
    const o = await observe(w, s), e = { ...o.elements[0]!, valueAvailable: available }
    return { ...o, elements: duplicate ? [e, { ...e, token: 'private-duplicate' }] : [e] }
  }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref }), locator = o.elements[0].locator
  await a.call('desktop_observe', { window: ref })
  const empty = await a.call('desktop_read_text', { window: ref, locator })
  assert.equal(empty.text, ''); assert.equal(empty.complete, true)
  available = false
  const missing = await a.call('desktop_read_text', { window: ref, locator })
  assert.equal(missing.text, null); assert.equal(missing.status, 'unavailable'); assert.equal(missing.source, 'unavailable')
  duplicate = true
  await assert.rejects(a.call('desktop_read_text', { window: ref, locator }), (e: any) => {
    assert.equal(e.code, 'ELEMENT_AMBIGUOUS'); assert.equal(e.diagnostics.matches, 2); return true
  })
  assert.equal(f.calls.length, 0)
})

test('truncated or degraded readback cannot upgrade uncertain replacement to verified', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  let degraded = false, complete = true
  f.driver.observe = async (w, s) => ({ ...await observe(w, s), degraded, elementsComplete: complete })
  const act = f.driver.act.bind(f.driver)
  f.driver.act = async (name, args, s) => { await act(name, args, s); degraded = true; return { status: 'unknown', message: 'unknown' } }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  const replacement = await a.call('desktop_type', { window: ref, element: o.elements[0].element, mode: 'replace', text: 'abcdef' })
  assert.equal(replacement.status, 'unknown'); assert.equal(replacement.observation.accessibility.degraded, true)
  const locator = o.elements[0].locator
  const truncated = await a.call('desktop_read_text', { window: ref, locator, maxChars: 3 })
  assert.equal(truncated.text, 'abc'); assert.equal(truncated.truncated, true); assert.equal(truncated.status, 'read')
  degraded = false; complete = false
  const partial = await a.call('desktop_read_text', { window: ref, locator })
  assert.equal(partial.text, 'abcdef'); assert.equal(partial.complete, true); assert.equal(partial.status, 'read')
  assert.equal(f.calls.length, 1)
})

test('read-text schema and references cannot escape session or bypass approval', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(), b = f.account('mon'); a.permissions.setMode('full_access'); b.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  await assert.rejects(b.call('desktop_read_text', { window: ref, locator: o.elements[0].locator }), /当前会话/)
  await assert.rejects(a.call('desktop_read_text', { window: ref }), /指定 element 或 locator/)
  await assert.rejects(a.call('desktop_read_text', { window: ref, element: o.elements[0].element, locator: o.elements[0].locator }), /指定 element 或 locator/)
  a.permissions.setMode('restricted')
  const pending = a.call('desktop_read_text', { window: ref, locator: o.elements[0].locator }), denied = assert.rejects(pending, /denied/)
  await tick(); a.permissions.resolve(a.permissions.list().find(p => p.state === 'pending')!.id, false)
  await denied
  assert.equal(f.calls.length, 0)
})

test('ancestor paths disambiguate same-labelled controls and do not depend on native indices', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  let generation = 0
  f.driver.observe = async (w, s) => {
    const o = await observe(w, s), base = o.elements[0]!, n = String(++generation * 10)
    return { ...o, elements: [
      { ...base, index: n + '1', role: 'Pane', label: 'Conversation' },
      { ...base, index: n + '2', parent: n + '1', label: 'Input', value: 'wrong' },
      { ...base, index: n + '3', role: 'Pane', label: 'Composer' },
      { ...base, index: n + '4', parent: n + '3', label: 'Input', value: 'right' },
    ] }
  }
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const o = await a.call('desktop_observe', { window: ref })
  const result = await a.call('desktop_read_text', { window: ref, locator: o.elements[3].locator })
  assert.equal(result.text, 'right'); assert.equal(result.status, 'read')
  await assert.rejects(a.call('desktop_read_text', { window: ref, locator: { role: 'Edit', label: 'Input' } }), /不唯一/)
})
