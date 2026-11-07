import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'

test('public imports survive a saved compaction and are not reinserted on restore', { timeout: 30_000 }, async t => {
  const model = await recordedModel([{ text: 'Answer '.repeat(500) }, { text: 'Summary: PUBLIC_BUDGET_500 remains relevant' }, { text: 'Continue' }])
  t.after(model.close)
  const record = callbacks(), history = [{ key: 'public-original', text: 'PUBLIC_BUDGET_500. ' + 'Context '.repeat(500), timestamp: '2026-11-06T00:00:00.000Z' }]
  const runtime = createRuntime({ sessionId: 'shared-compaction', systemPrompt: 'Public group helper.', model: model.config, tools: [], callbacks: record.handlers, history })
  await runtime.prompt('A asks a question')
  await runtime.compact('Preserve the public budget')
  const checkpoint = await runtime.snapshot()
  assert.ok(checkpoint.entries.some(value => value && typeof value === 'object' && !Array.isArray(value) && value.type === 'compaction'))
  const restored = createRuntime({ sessionId: 'shared-compaction', systemPrompt: 'Public group helper.', model: model.config,
    tools: [], callbacks: record.handlers, checkpoint, history })
  await restored.prompt('B follows up')
  assert.match(JSON.stringify(model.requests.at(-1)), /PUBLIC_BUDGET_500/)
  const final = await restored.snapshot()
  const imports = final.entries.filter(value => value && typeof value === 'object' && !Array.isArray(value) && value.type === 'custom_message'
    && value.customType === 'eden.qq.public_message')
  assert.equal(imports.length, 1)
  assert.equal(model.requests.length, 3)
})
