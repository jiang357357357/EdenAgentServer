import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MonClient, MonHttpError } from '@eden/integrations'
import { coreSettingsSchema } from '../src/modules/mon/model-schema.ts'
import { loadMonCatalog } from '../src/modules/mon/model-catalog.ts'

test('Core empty default selection is treated as unset while valid identities are preserved', () => {
  for (const value of ['', '  ', null]) assert.equal(coreSettingsSchema.parse({ default_model: value }).default_model, null)
  assert.equal(coreSettingsSchema.parse({}).default_model, undefined)
  for (const value of [2, '2']) assert.equal(coreSettingsSchema.parse({ default_model: value }).default_model, value)
  assert.equal(coreSettingsSchema.safeParse({ default_model: {} }).success, false)
})

test('invalid Core settings report an upstream configuration error without leaking returned data', async () => {
  const client = new MonClient('http://127.0.0.1:1', 'fixture-only')
  client.get = async endpoint => endpoint === '/api/assistants/current/'
    ? { id: 1, name: 'Fixture', character: { id: 1, name: 'Fixture' } }
    : endpoint === '/api/agent/settings/my/' ? { default_model: { credential: 'private-fixture' } } : {}
  client.getCollection = async () => []
  await assert.rejects(loadMonCatalog(client), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Core 模型目录数据格式不兼容/)
    assert.doesNotMatch(error.message, /private-fixture|Invalid request parameters/)
    return true
  })
})

test('a removed session assistant is reported as an actionable identity error', async () => {
  const client = new MonClient('http://127.0.0.1:1', 'fixture-only')
  client.get = async endpoint => {
    if (endpoint === '/api/assistants/21/') throw new MonHttpError(404)
    return {}
  }
  client.getCollection = async () => []
  await assert.rejects(loadMonCatalog(client, 21), /会话助手（ID：21）已不在 Mon Core 中，请为本会话重新选择助手。/)
})
