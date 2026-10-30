import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopFixture } from './fixture.ts'

test('unknown replacement is confirmed only by an exact unambiguous readback and returns refreshed references', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const before = await a.call('desktop_observe', { window: ref })
  const act = f.driver.act
  f.driver.act = async (...args) => { await act(...args); return { status: 'unknown', effect: 'unverifiable', message: 'fixture cannot verify' } }
  const result = await a.call('desktop_type', { window: ref, element: before.elements[0].element, mode: 'replace', text: '精确读回' })
  assert.equal(result.status, 'verified'); assert.equal(result.verification.state, 'confirmed')
  assert.equal(result.verification.scope, 'accessible_value'); assert.equal(result.execution.state, 'dispatched')
  assert.equal(result.execution.driverStatus, 'unknown')
  assert.equal(result.effect, 'unverifiable'); assert.equal(result.verification.evidence[0].source, 'value')
  assert.equal(result.observation.elements[0].value, '精确读回')
  assert.notEqual(result.observation.elements[0].element, before.elements[0].element)
  await assert.rejects(a.call('desktop_click', { window: ref, element: before.elements[0].element }), /已失效/)
  assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /private-|windowId/)
})

test('uncertain insert is observed once without replay or false success', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  const ref = (await a.call('desktop_list_windows', {})).windows[0].window
  const before = await a.call('desktop_observe', { window: ref })
  const act = f.driver.act
  f.driver.act = async (...args) => { await act(...args); return { status: 'unknown', effect: 'partial', message: 'partial' } }
  const result = await a.call('desktop_type', { window: ref, element: before.elements[0].element, text: 'possibly delivered' })
  assert.equal(result.status, 'unknown'); assert.equal(result.effect, 'partial')
  assert.equal(result.verification.state, 'confirmed'); assert.equal(result.execution.state, 'partial'); assert.ok(result.observation)
  assert.equal(f.calls.length, 1)
})

test('ambiguous editable controls and failed observation never turn unknown input into success', async t => {
  for (const mode of ['ambiguous', 'unavailable']) {
    const f = await desktopFixture(); t.after(() => f.close())
    const a = f.account(); a.permissions.setMode('full_access')
    const ref = (await a.call('desktop_list_windows', {})).windows[0].window
    const before = await a.call('desktop_observe', { window: ref })
    const observe = f.driver.observe
    f.driver.observe = async (...args) => {
      if (mode === 'unavailable') throw new Error('fixture observation failed')
      const state = await observe(...args)
      state.elements.push({ ...state.elements[0]!, token: 'private-second-control' }); return state
    }
    f.driver.act = async () => ({ status: 'unknown', message: 'uncertain' })
    const result = await a.call('desktop_type', { window: ref, element: before.elements[0].element, mode: 'replace', text: 'expected' })
    assert.equal(result.status, 'unknown')
    assert.equal(result.verification.state, mode === 'unavailable' ? 'unavailable' : 'unconfirmed')
    if (mode === 'unavailable') assert.equal(result.observationError.code, 'POST_ACTION_OBSERVATION_FAILED')
  }
})
