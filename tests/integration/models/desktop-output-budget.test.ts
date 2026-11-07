import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadConfig } from '../../../src/bootstrap/config.ts'

const require = createRequire(import.meta.url)
const { createLocalRuntimeConfigStore } = require('../../../../frontend/desktop/src/app/local-runtime-config.cjs')

test('the persisted desktop output budget reaches the host through its actual runtime environment', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-desktop-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createLocalRuntimeConfigStore({ app: { isPackaged: true, getPath: () => root }, agentRoot: root })
  store.save({ provider: 'custom', model: 'custom/budget-model', baseUrl: 'http://127.0.0.1:8888/v1',
    apiKey: 'isolated-test-key', contextWindow: 32768, maxOutputTokens: 12288 })
  const config = loadConfig({ ...store.environment({}), EDEN_AGENT_DATA_ROOT: path.join(root, 'host') }, root)
  assert.equal(config.model?.maxTokens, 12288)
  assert.equal(config.model?.contextWindow, 32768)
})

test('desktop output names retain the standalone alias and enforce the model context budget', () => {
  const env = { EDEN_AGENT_MODEL: 'custom/budget-model', EDEN_AGENT_BASE_URL: 'http://127.0.0.1:8888/v1', EDEN_AGENT_CONTEXT_WINDOW: '32768' }
  assert.equal(loadConfig({ ...env, EDEN_AGENT_MAX_TOKENS: '8192' }).model?.maxTokens, 8192)
  assert.equal(loadConfig({ ...env, EDEN_AGENT_MAX_TOKENS: '8192', EDEN_AGENT_MAX_OUTPUT_TOKENS: '12288' }).model?.maxTokens, 12288)
  assert.throws(() => loadConfig({ ...env, EDEN_AGENT_MAX_OUTPUT_TOKENS: '65536' }), /budget/)
})
