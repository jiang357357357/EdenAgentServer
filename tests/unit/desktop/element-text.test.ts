import assert from 'node:assert/strict'
import test from 'node:test'
import { elementText, uniqueElement } from '../../../src/modules/desktop/element-text.ts'
import type { NativeElement, NativeObservation, NativeWindow } from '../../../src/modules/desktop/contracts.ts'

const window: NativeWindow = { pid: 1, windowId: '1', app: 'Fixture', title: 'Fixture', minimized: false,
  bounds: { x: 0, y: 0, width: 400, height: 300 } }
const text: NativeElement = { token: '', index: '0', role: 'Text', label: 'text', value: '', valueAvailable: false,
  enabled: true, actions: [] }
const observation = (elements: NativeElement[]): NativeObservation => ({ window, elements, images: [], width: 0, height: 0,
  truncated: false, elementsComplete: true })

test('clipped labels and values cannot provide an exact confirmed text read', () => {
  const label = { ...text, labelTruncated: true }, o = observation([label])
  assert.throws(() => uniqueElement({ role: 'Text', label: 'text' }, o), /标签被截断/)
  assert.equal(elementText(label, o, 100).complete, false)
  const value = { ...text, value: 'clipped', valueAvailable: true, valueTruncated: true }
  const result = elementText(value, observation([value]), 100)
  assert.equal(result.text, 'clipped'); assert.equal(result.complete, false); assert.equal(result.truncated, true)
})

test('intact scalar text is complete without a full tree; missing descendant text stays unavailable', () => {
  const o = observation([text]); delete o.elementsComplete
  assert.equal(elementText(text, o, 100).complete, true)
  const noText = { ...text, role: 'Document', label: 'editor label' }
  assert.equal(elementText(noText, observation([noText]), 100).text, null)
  assert.throws(() => uniqueElement({ role: 'Edit', label: 'absent' }, o), /目标缺失/)
})
