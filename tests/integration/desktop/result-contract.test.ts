import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopFixture } from './fixture.ts'
import type { NativeElement } from '../../../src/modules/desktop/contracts.ts'
import { projectRecordedResult } from '../../../src/modules/tool-results/model-result-catalog.ts'

async function setup() {
  const f = await desktopFixture(), a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  return { ...f, a, ref }
}

test('a scoped scalar read confirms input in an incomplete tree with multiple edit controls', async t => {
  const f = await setup(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver), act = f.driver.act.bind(f.driver)
  f.driver.observe = async (...args) => {
    const state = await observe(...args)
    return { ...state, elementsComplete: false, truncated: true, elements: [
      { ...state.elements[0]!, valueAvailable: true },
      { ...state.elements[0]!, token: 'other', label: 'Unrelated search', value: 'elsewhere' },
    ] }
  }
  f.driver.act = async (...args) => { await act(...args); return { status: 'unknown', effect: 'unverifiable', route: 'global_input', message: 'no action ack' } }
  const before = await f.a.call('desktop_observe', { window: f.ref })
  const { raw, value } = await f.a.callModel('desktop_type', { window: f.ref, element: before.elements[0].element, mode: 'replace', text: 'expected' })
  assert.equal(value.execution.state, 'dispatched'); assert.equal(value.verification.state, 'confirmed')
  assert.equal(value.verification.scope, 'accessible_value'); assert.equal(value.status, 'verified')
  assert.equal(raw.observation.accessibility.complete, false); assert.equal(f.calls.length, 1)
  const stored = f.a.database.connection.prepare("SELECT state,result_json FROM desktop_operations WHERE action='desktop_type'").get()!
  assert.equal(stored.state, 'completed'); assert.deepEqual(JSON.parse(String(stored.result_json)), raw)
})

test('history text never verifies a different input; partial descendants stay partial', async t => {
  for (const containsTarget of [false, true]) {
    const f = await setup(); t.after(() => f.close())
    const observe = f.driver.observe.bind(f.driver)
    const node = (index: string, parent: string | undefined, role: string, label: string): NativeElement => ({
      index, ...(parent ? { parent } : {}), role, label, value: '', valueAvailable: false, token: `node-${index}`, enabled: true, actions: ['text'],
    })
    let acted = false
    f.driver.observe = async (...args) => ({ ...await observe(...args), elementsComplete: false, elements: [
      node('0', undefined, 'Pane', 'Chat'), node('1', '0', 'Group', 'Composer'),
      node('2', '1', 'Text', acted && containsTarget ? 'expected' : 'other'), node('3', '0', 'Text', 'expected'),
    ] })
    f.driver.act = async () => { acted = true; return { status: 'unknown', effect: 'unverifiable', message: 'no ack' } }
    const state = await f.a.call('desktop_observe', { window: f.ref })
    const { value } = await f.a.callModel('desktop_type', { window: f.ref, element: state.elements[1].element, text: 'expected' })
    assert.equal(value.status, 'delivered'); assert.equal(value.execution.state, 'dispatched')
    assert.equal(value.verification.state, containsTarget ? 'partial' : 'unconfirmed')
    assert.equal(value.verification.evidence[0].text, containsTarget ? 'expected' : 'other')
    assert.equal(value.verification.evidence[0].complete, false)
  }
})

test('dynamic OS window titles permit exact readonly targets but never loosen business ancestor matching', async t => {
  const f = await setup(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  let title = 'Original', group = 'Recipient A'
  f.driver.observe = async (...args) => {
    const state = await observe(...args)
    return { ...state, window: { ...state.window, title }, elements: [
      { ...state.elements[0]!, index: '0', role: 'Window', label: title },
      { ...state.elements[0]!, index: '1', parent: '0', role: 'Group', label: group },
      { ...state.elements[0]!, index: '2', parent: '1', label: 'Composer', value: 'draft', valueAvailable: true },
    ] }
  }
  const before = await f.a.call('desktop_observe', { window: f.ref })
  title = 'Updated'
  const read = await f.a.call('desktop_read_text', { window: f.ref, element: before.elements[2].element })
  assert.equal(read.text, 'draft'); assert.equal(read.context.titleChanged, true)
  assert.equal(read.context.businessTargetUnchanged, 'not_established')
  assert.equal(read.locator.ancestors[0].label, 'Updated')
  group = 'Recipient B'
  await assert.rejects(f.a.call('desktop_read_text', { window: f.ref, element: read.element }), /缺失或不唯一/)
  assert.equal(f.calls.length, 0)
})

test('expect verifies specified UI facts without replay and does not claim remote delivery', async t => {
  const f = await setup(); t.after(() => f.close())
  const act = f.driver.act.bind(f.driver)
  f.driver.act = async (...args) => { await act(...args); f.values.set('1', 'after'); return { status: 'unknown', effect: 'unverifiable', message: 'no ack' } }
  let state = await f.a.call('desktop_observe', { window: f.ref })
  const checked = await f.a.call('desktop_click', { window: f.ref, element: state.elements[0].element,
    expect: [{ kind: 'text_equals', locator: { role: 'Edit', label: 'Input' }, text: 'after' }] })
  assert.equal(checked.verification.state, 'confirmed'); assert.equal(checked.verification.scope, 'expected_ui_state')
  assert.equal(checked.changes.causalAttribution, 'not_established'); assert.equal(checked.observationReady, true)
  assert.match(checked.message, /不代表远端/); assert.equal(f.calls.length, 1)
  state = checked.observation
  const wrong = await f.a.call('desktop_click', { window: f.ref, element: state.elements[0].element,
    expect: [{ kind: 'text_equals', locator: { role: 'Edit', label: 'Input' }, text: 'wrong' }] })
  assert.equal(wrong.verification.state, 'mismatch'); assert.equal(wrong.status, 'delivered'); assert.equal(f.calls.length, 2)
})

test('an absence condition needs a complete tree and ambiguity cannot verify a target', async t => {
  const f = await setup(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (...args) => ({ ...await observe(...args), elementsComplete: false })
  let state = await f.a.call('desktop_observe', { window: f.ref })
  const absent = await f.a.call('desktop_click', { window: f.ref, element: state.elements[0].element,
    expect: [{ kind: 'absent', locator: { role: 'Text', label: 'missing' } }] })
  assert.equal(absent.verification.state, 'unconfirmed')
  const original = f.driver.observe.bind(f.driver)
  f.driver.observe = async (...args) => { const value = await original(...args); value.elements.push({ ...value.elements[0]!, token: 'duplicate' }); return value }
  state = await f.a.call('desktop_observe', { window: f.ref })
  const ambiguous = await f.a.call('desktop_click', { window: f.ref, element: state.elements[0].element,
    expect: [{ kind: 'present', locator: { role: 'Edit', label: 'Input' } }] })
  assert.equal(ambiguous.verification.state, 'unconfirmed'); assert.equal(ambiguous.verification.evidence[0].reason, 'target_ambiguous')
})

test('model views bound repeated trees, preserve fresh callable refs, and leave audit and historical rows intact', async t => {
  const f = await setup(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver)
  f.driver.observe = async (...args) => {
    const state = await observe(...args)
    return { ...state, elements: [...Array.from({ length: 160 }, (_, i) => ({ ...state.elements[0]!,
      index: `${i + 1}`, token: `noise-${i}`, role: 'Text', actions: [], value: f.values.get('1') ?? '', label: `History ${i} ${'x'.repeat(1000)}` })), ...state.elements] }
  }
  const initial = await f.a.callModel('desktop_observe', { window: f.ref, query: 'Input' })
  assert.equal(initial.raw.elements.length, 161); assert.ok(initial.value.omittedElements > 0)
  assert.ok(JSON.stringify(initial.value).length < 30000)
  const first = await f.a.callModel('desktop_type', { window: f.ref, element: initial.value.elements[0].element, mode: 'replace', text: 'first' })
  const next = first.value.observation.elements.find((item: any) => item.role === 'Edit')
  assert.equal(first.value.observationReady, true); assert.equal(next.value, 'first')
  const second = await f.a.callModel('desktop_type', { window: f.ref, element: next.element, mode: 'replace', text: 'second' })
  assert.equal(second.value.verification.state, 'confirmed'); assert.equal(f.calls.length, 2)
  assert.equal(second.value.observation.elements[0].role, 'Edit', 'target must stay ahead of concurrent history changes')
  const rawSize = JSON.stringify(second.raw).length, modelSize = JSON.stringify(second.value).length
  t.diagnostic(JSON.stringify({ rawCharacters: rawSize, modelCharacters: modelSize, reductionPercent: (1 - modelSize / rawSize) * 100 }))
  assert.ok(modelSize < rawSize / 4, `${modelSize} vs ${rawSize}`)
  assert.ok(modelSize < 18000)
  const rawCopy = JSON.stringify(second.raw)
  const historical = projectRecordedResult('desktop_type', second.raw) as any
  assert.deepEqual(historical, second.value); assert.equal(JSON.stringify(second.raw), rawCopy)
  const targeted = await f.a.callModel('desktop_observe', { window: f.ref, query: 'History 159', maxElements: 1 })
  assert.equal(targeted.value.elements.length, 1); assert.match(targeted.value.elements[0].label, /History 159/)
  assert.equal(targeted.value.elements[0].labelTruncated, true)
})

test('existing identical input does not prove that an insertion happened', async t => {
  const f = await setup(); t.after(() => f.close())
  f.values.set('1', 'already here')
  f.driver.act = async () => ({ status: 'unknown', effect: 'suspected_noop', message: 'no change' })
  const state = await f.a.call('desktop_observe', { window: f.ref })
  const result = await f.a.call('desktop_type', { window: f.ref, element: state.elements[0].element, text: 'already here' })
  assert.equal(result.verification.state, 'partial'); assert.equal(result.execution.state, 'dispatched')
  assert.equal(result.verification.evidence[0].beforeText, 'already here')
})

test('confirmed actions retain screenshots in audit; partial execution retains the model image too', async t => {
  const f = await setup(); t.after(() => f.close())
  const observe = f.driver.observe.bind(f.driver), act = f.driver.act.bind(f.driver)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  f.driver.observe = async (...args) => ({ ...await observe(...args), images: [{ mime: 'image/png', data: png }] })
  let partial = false
  f.driver.act = async (...args) => { await act(...args); return { status: 'unknown', effect: partial ? 'partial' : 'unverifiable', message: 'no ack' } }
  const state = await f.a.call('desktop_observe', { window: f.ref })
  const confirmed = await f.a.callModel('desktop_type', { window: f.ref, element: state.elements[0].element, mode: 'replace', text: 'first' })
  assert.equal(confirmed.raw.images.length, 1); assert.equal(confirmed.images.length, 0); assert.equal(confirmed.value.images, undefined)
  partial = true
  const next = confirmed.value.observation.elements.find((item: any) => item.role === 'Edit')
  const uncertain = await f.a.callModel('desktop_type', { window: f.ref, element: next.element, mode: 'replace', text: 'second' })
  assert.equal(uncertain.value.execution.state, 'partial'); assert.equal(uncertain.value.status, 'unknown')
  assert.equal(uncertain.images.length, 1); assert.equal(uncertain.value.images.length, 1)
})

test('query outputs have observation semantics and native trees omit duplicate full text', async t => {
  const f = await setup(); t.after(() => f.close())
  f.driver.native = async name => ({ status: 'delivered', message: '动作已送达，请重新观察确认结果', text: 't'.repeat(100000), images: [],
    structuredJson: JSON.stringify(name === 'list_windows' ? { windows: [] } : { elements: Array.from({ length: 150 }, (_, element_index) => ({
      element_index, role: 'Text', label: `Entry ${element_index}`, value: '', ancestors: 'a'.repeat(1000),
    })), tree_markdown: 't'.repeat(100000) }) })
  const list = await f.a.callModel('cua_list_windows', {})
  assert.equal(list.value.kind, 'observation'); assert.equal(list.value.status, 'read')
  assert.equal(list.value.execution.state, 'not_applicable'); assert.equal(list.value.nextAction, 'use_returned_result')
  assert.doesNotMatch(list.value.message, /动作|重新观察/)
  const tree = await f.a.callModel('cua_get_accessibility_tree', {})
  assert.equal(tree.value.text, undefined); assert.equal(tree.value.data.tree_markdown, undefined)
  assert.equal(tree.value.data.elements.length, 80); assert.equal(tree.value.data.omittedElements, 70)
  assert.ok(JSON.stringify(tree.value).length < 20000)
})
