import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCoreModel } from '../../../src/modules/mon/model-schema.ts'
const entity = { id: 2, ai_model: 'deepseek-v4-flash', vendor: 'deepseek', status: 'active', api_key: 'fixture', api_endpoint: 'https://api.deepseek.com' }

test('Core legacy thinking and sampling survive model binding', () => {
  const { model } = resolveCoreModel({ ...entity, default_params: { thinking_enabled: true, reasoning_effort: 'medium', temperature: 0.8, top_p: 0.98, presence_penalty: 0.2, frequency_penalty: 0.3 } })
  assert.equal(model.reasoning, 'medium')
  assert.deepEqual(model.sampling, { temperature: 0.8, topP: 0.98, presencePenalty: 0.2, frequencyPenalty: 0.3 })
})
test('native disabled overrides legacy enabled; absent parameters stay provider defaults', () => {
  assert.equal(resolveCoreModel({ ...entity, default_params: { thinking: { type: 'disabled' }, thinking_enabled: true, reasoning_effort: 'high' } }).model.reasoning, 'off')
  const { model } = resolveCoreModel(entity)
  assert.equal(model.reasoning, undefined)
  assert.equal(model.sampling, undefined)
  assert.throws(() => resolveCoreModel({ ...entity, default_params: { temperature: 9 } }))
})
