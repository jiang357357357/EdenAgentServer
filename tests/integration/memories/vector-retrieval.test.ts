import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MemoryRecord } from '@eden/api'
import { MonClient } from '@eden/integrations'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { coreMemoryRetrieval, LocalMemoryRetrieval } from '../../../src/modules/memories/index.ts'
import { createServices } from '../../../src/bootstrap/services.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { withAccount, accountKey } from '../../../src/modules/accounts/index.ts'

const coreRoot = path.resolve('..', 'Core')
const python = process.env.EDEN_TEST_CORE_PYTHON ?? path.join(coreRoot, '.venv/Scripts/python.exe')
const script = path.join(coreRoot, 'Application/Dependencies/ServiceProvider/Recall/tests/run_vector_contracts.py')
// Explicit public model fixture; production Local has no Core-model fallback.
const modelPath = process.env.EDEN_TEST_MEMORY_MODEL_PATH ?? path.resolve(coreRoot, '../Data/Os/Models/bge-small-zh-v1.5')
const available = existsSync(python) && existsSync(script) && existsSync(path.join(modelPath, 'model.safetensors'))

function memory(id: number, content: string, metadata = {}): MemoryRecord {
  return { id, content, metadata, kind: 'fact', scopeType: 'agent_character', scopeKey: '11', sourceSessionId: '', createdAt: 1, updatedAt: 1 }
}

test('Agent client → isolated actual Core HTTP/ORM/ONNX agrees with independent Local retrieval', { skip: !available }, async context => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'eden-memory-http-'))
  const child = spawn(python, ['-B', '-u', script, '--serve'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MONCORE_TESTING: '1', MON_TEST_LOG_DIR: path.join(scratch, 'logs') } })
  const lines = createInterface({ input: child.stdout })
  let errors = ''
  child.stderr.on('data', data => { errors += data.toString() })
  context.after(async () => {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Core fixture startup timeout: ${errors.slice(-500)}`)), 20000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Core fixture exited: ${errors.slice(-500)}`)) })
    lines.on('line', line => { try { const value = JSON.parse(line); if (value.port) { clearTimeout(timeout); resolve(value.port) } } catch {} })
  })
  const client = new MonClient(`http://127.0.0.1:${port}`, 'isolated-memory-token')
  const local = new LocalMemoryRetrieval(modelPath)
  context.after(() => local.close())
  const candidates = [memory(1, '用户不吃辣，点餐选择清淡菜式。'), memory(2, '检查自醒调度器和Windows启动日志。'),
    memory(3, '用户不吃辣，点餐选择清淡菜式。', { validUntil: Date.now() - 1000 })]
  const input = { sessionId: 'fixture', scope: { scopeType: 'agent_character' as const, scopeKey: '11' }, query: candidates[0]!.content, candidates }
  const request = (_id: string, body: Parameters<MonClient['post']>[1], signal?: AbortSignal) => client.post('/api/agent/memories/retrieve/', body, signal)
  const core = await coreMemoryRetrieval(input, request)
  const standalone = await local.retrieve(input)
  assert.deepEqual(core.map(item => item.id), [1])
  assert.deepEqual(standalone.map(item => item.id), [1])
  assert.ok(Math.abs(core[0]!.similarity - standalone[0]!.similarity) < 0.00002)
  assert.deepEqual(await coreMemoryRetrieval({ ...input, query: '你好' }, request), [])
  assert.deepEqual(await local.retrieve({ ...input, query: '你好' }), [])
  await assert.rejects(coreMemoryRetrieval({ ...input, scope: { ...input.scope, scopeKey: '22' } }, request), /404|角色/)
  await verifySession(context, request)
})

async function verifySession(context: test.TestContext, request: Parameters<typeof coreMemoryRetrieval>[1]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-core-recall-'))
  const db = new EdenDatabase(':memory:', 'mon')
  const services = createServices(db, loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_DATA_ROOT: root }), {
    memoryRetrieval: input => coreMemoryRetrieval(input, request),
  })
  const model = await recordedModel([{ text: '选择清淡菜式。' }, { text: '你好，老师。' }])
  context.after(async () => {
    await Promise.all([services.sessions.close(), services.plugins.close(), services.companion.close(), services.mon.close(), model.close()])
    services.questions.close(); db.close(); await rm(root, { recursive: true, force: true })
  })
  await withAccount({ userId: 'fixture', coreBaseUrl: 'http://localhost:40011', key: accountKey('http://localhost:40011', 'fixture') }, async () => {
    const session = services.repository.create('Real Core recall', [{ assistantId: 1, characterId: 11 }])
    services.models.bind(session.id, { model: model.config, entityId: 1, label: 'recorded' })
    services.memories.create({ scopeType: 'agent_character', scopeKey: '11' }, '用户不吃辣，点餐选择清淡菜式。')
    services.memories.create({ scopeType: 'agent_character', scopeKey: '11' }, '检查自醒调度器和Windows启动日志。')
    services.sessions.start(session.id, '用户不吃辣，点餐选择清淡菜式。')
    await services.sessions.waitForIdle(session.id)
    services.sessions.start(session.id, '你好')
    await services.sessions.waitForIdle(session.id)
    assert.equal(services.sessions.faultCount(), 0)
    assert.equal(model.requests.length, 2)
    const first = model.requests[0]!.messages as { role: string; content: unknown }[]
    const second = model.requests[1]!.messages as { role: string; content: unknown }[]
    assert.deepEqual(first[0], second[0])
    assert.match(JSON.stringify(first), /本轮相关长期记忆/)
    assert.doesNotMatch(JSON.stringify(second), /本轮相关长期记忆|Windows启动日志/)
    assert.doesNotMatch(JSON.stringify(services.repository.checkpoint(session.id)), /本轮相关长期记忆/)
    assert.doesNotMatch(JSON.stringify(services.repository.events.messages(session.id, undefined, 100)), /本轮相关长期记忆/)
  })
}

test('Core batches every candidate, combines global top five, and rejects unexpected IDs', async () => {
  const candidates = Array.from({ length: 260 }, (_, index) => memory(index + 1, 'fixture'))
  let calls = 0
  const input = { sessionId: 'fixture', scope: { scopeType: 'agent_character' as const, scopeKey: '11' }, query: 'topic', candidates }
  const hits = await coreMemoryRetrieval(input, async (_id, raw) => {
    calls++
    const body = raw as { documents: { id: string }[] }
    return { source: 'agent-local', method: 'vector_threshold', threshold: 0.6,
      items: body.documents.slice(-5).reverse().map(item => ({ id: item.id, similarity: Number(item.id) / 1000 + 0.6 })) }
  })
  assert.equal(calls, 3)
  assert.deepEqual(hits.map(item => item.id), [260, 259, 258, 257, 256])
  await assert.rejects(coreMemoryRetrieval(input, async () => ({ source: 'agent-local', method: 'vector_threshold', threshold: 0.6, items: [{ id: '999', similarity: 0.8 }] })), /Invalid Core/)
})
