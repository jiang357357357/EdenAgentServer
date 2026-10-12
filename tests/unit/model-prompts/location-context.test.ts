import assert from 'node:assert/strict'
import test from 'node:test'
import { modelEnvironment, sessionEnvironmentSchema, toJson } from '@eden/api'
import { actorSystemContent } from '../../../src/modules/actors/actor-prompt.ts'
import { sessionPromptContent } from '../../../src/modules/sessions/turn/session-prompt.ts'
import { selfAwakePrompt, selfAwakePromptContext } from '../../../src/modules/self-awake/prompt.ts'
import { modelSelfAwakeContext } from '../../../src/modules/self-awake/context.ts'

const environment = { timezone: 'Asia/Shanghai', locale: 'zh-CN', location: {
  country: '中国', region: '海南省', city: '儋州市', district: '', source: 'manual_map',
  updated_at: '2026-09-20T08:15:00+08:00', accuracy: 25, latitude: 19.523457, longitude: 109.576543,
}, privateToken: 'private-environment-token' }

test('normal, actor and self-awake prompts share location provenance without leaking the stored coordinates', () => {
  const before = JSON.stringify(environment)
  const single = sessionPromptContent({ environment })
  const actor = actorSystemContent({}, { environment })
  const awake = selfAwakePromptContext({ environment })
  const request = modelSelfAwakeContext({ run: { id: 'run', status: 'running', request: { environment } } })
  const expected = single.sources.find(source => source.title === '环境信息')!.content
  assert.deepEqual(actor.sources.find(source => source.title === '环境信息')!.content, expected)
  assert.deepEqual(awake.environment, expected)
  assert.deepEqual((request as Record<string, unknown>).environment, expected)
  for (const text of [single.prompt, actor.prompt, selfAwakePrompt({ environment }), JSON.stringify(request)]) {
    assert.match(text, /儋州市/)
    assert.match(text, /manual_map/)
    assert.match(text, /2026-09-20T08:15:00\+08:00/)
    assert.match(text, /"accuracy":25/)
    assert.match(text, /位置为保存的资料快照/)
    assert.match(text, /是否仍在该位置尚未核实/)
    assert.doesNotMatch(text, /latitude|longitude|19\.523457|109\.576543|private-environment-token/)
  }
  assert.equal(JSON.stringify(environment), before)
})

test('older reports retain their place while missing location provenance remains unknown', () => {
  for (const location of [{ city: '儋州市' }, { city: '儋州市', source: null, updated_at: null, accuracy: null }]) {
    const output = modelEnvironment({ timezone: 'Asia/Shanghai', location })!
    assert.equal(output.location!.city, '儋州市')
    assert.equal(output.location!.source, null)
    assert.equal(output.location!.updated_at, null)
    assert.equal(output.location!.accuracy, null)
    assert.doesNotMatch(JSON.stringify(output), /browser_geolocation|manual_map/)
  }
  const absent = sessionPromptContent({ environment: { timezone: 'Asia/Shanghai' } }).prompt
  assert.doesNotMatch(absent, /locationInterpretation|儋州市/)
})

test('ambiguous or invalid location timestamps do not become verified observation times', () => {
  for (const updated_at of ['', 'yesterday', '2026-09-20T08:15:00', '2026-02-30T08:15:00Z']) {
    const input = { ...environment, location: { ...environment.location, updated_at } }
    const stored = sessionEnvironmentSchema.parse(input)!
    assert.equal(stored.location!.updated_at, updated_at)
    const projected = modelEnvironment(toJson(stored))!
    assert.equal(projected.location!.updated_at, null)
    assert.equal(projected.location!.city, '儋州市')
  }
})

test('location accuracy keeps zero and rejects invalid distances at the input boundary', () => {
  assert.equal(modelEnvironment({ location: { accuracy: 0 } })!.location!.accuracy, 0)
  for (const accuracy of [-1, Infinity, NaN, '25']) {
    assert.equal(sessionEnvironmentSchema.safeParse({ location: { accuracy } }).success, false)
  }
})
