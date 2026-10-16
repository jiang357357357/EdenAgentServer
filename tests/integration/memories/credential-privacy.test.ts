import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { credentialValues, redactCredentialJson, type RuntimeCheckpoint } from '@eden/api'
import { recordedModel } from '@eden/runtime-pi/testing'
import { createServices } from '../../../src/bootstrap/services.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { MemoryRepository } from '../../../src/modules/memories/index.ts'
import { privateMemoryCheckpoint } from '../../../src/modules/tool-results/index.ts'

test('credential detection covers quoted, backtick and Chinese assignments without treating custody references as secrets', () => {
  for (const content of ['sudo 密码是 x-Fixture-123', 'password="x-Fixture 123"', 'API_KEY: `x-Fixture-123`', '密码：x-Fixture-123']) assert.ok(credentialValues(content).length)
  const long = 'fixture-' + 'x'.repeat(1024)
  assert.deepEqual(credentialValues(`refresh_token="${long}"`), [long])
  assert.deepEqual(credentialValues('password=fixture<angle>value'), ['fixture<angle>value'])
  for (const content of ['sudo 密码由老师保管', '密码是老师保管', 'password: [已隐藏凭据]', 'password: <USER_PASSWORD>']) assert.deepEqual(credentialValues(content), [])
  assert.deepEqual(redactCredentialJson({ id: 'keep-id', toolCallId: 'keep-call', metadata: { password: 'fixture-secret' } }),
    { id: 'keep-id', toolCallId: 'keep-call', metadata: { password: '[已隐藏凭据]' } })
})

test('legacy credential memory reads are hidden, metadata is masked, and new credential writes are rejected', () => {
  const db = new EdenDatabase(':memory:', 'local'), memories = new MemoryRepository(db), scope = { scopeType: 'agent_character' as const, scopeKey: '7' }
  try {
    const record = memories.create(scope, '普通记忆', 'fact', '', { password: 'metadata-secret' })
    db.connection.prepare('UPDATE memories SET content=? WHERE id=?').run('sudo 密码：legacy-fixture-secret', record.id)
    assert.doesNotMatch(JSON.stringify(memories.read(scope, record.id)), /legacy-fixture-secret|metadata-secret/)
    assert.doesNotMatch(JSON.stringify(memories.search(scope)), /legacy-fixture-secret/)
    assert.throws(() => memories.create(scope, 'sudo 密码是新密码'), /Credentials/)
    assert.throws(() => memories.create(scope, '复制旧值 legacy-fixture-secret'), /Credentials/)
    const checkpoint: RuntimeCheckpoint = { format: 'eden.pi-harness.v1', runtimeVersion: '0.82.0', sessionId: 'fixture', createdAt: 'now', entries: [
      { id: 'e1', parentId: null, type: 'message', message: { role: 'toolResult', toolName: 'search_memories', toolCallId: 'c1',
        content: [{ type: 'text', text: JSON.stringify([{ id: 30, content: 'sudo 密码：legacy-fixture-secret' }]) }] } },
      { id: 'e2', parentId: 'e1', type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '复制 legacy-fixture-secret' }] } },
      { id: 'e3', parentId: 'e2', type: 'compaction', summary: '历史 legacy-fixture-secret' },
    ] }
    const safe = privateMemoryCheckpoint(checkpoint, memories.credentialValues())
    assert.doesNotMatch(JSON.stringify(safe), /legacy-fixture-secret/)
    const first = safe.entries[0] as { message: { content: { text: string }[] } }
    assert.equal(JSON.parse(first.message.content[0]!.text)[0].id, 30)
    assert.equal((safe.entries[1] as { parentId: string }).parentId, 'e1')
  } finally { db.close() }
})

test('isolated production turns hide credentials in approvals, operation audit, persisted and subsequent live context', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-memory-privacy-')), db = new EdenDatabase(':memory:', 'local')
  const secret = 'synthetic-sudo-password', model = await recordedModel([
    { tool: 'search_memories', input: {} },
    { tool: 'remember_memory', input: { content: `sudo 密码是 ${secret}` } },
    { tool: 'load_tools', input: { tools: [{ id: 'builtin:forget_memory' }] } },
    { tool: 'forget_memory', input: { id: 1 } }, { text: '已清理' },
  ])
  const services = createServices(db, { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root }), model: model.config })
  t.after(async () => { await Promise.all([services.sessions.close(), services.plugins.close(), services.companion.close(), services.mon.close(), services.browser.close()]); db.close(); await model.close(); await rm(root, { recursive: true, force: true }) })
  const session = services.repository.create('凭据修复测试', [{ assistantId: 1, characterId: 7 }])
  services.memories.create({ scopeType: 'agent_character', scopeKey: '7' }, '旧记忆')
  db.connection.prepare('UPDATE memories SET content=? WHERE id=1').run(`sudo 密码：${secret}`)
  services.repository.events.subscribe(event => {
    if (event.kind !== 'permission.requested') return
    assert.doesNotMatch(JSON.stringify(event.payload), new RegExp(secret))
    const request = services.permissions.list(session.id).find(item => item.state === 'pending')!
    services.permissions.resolve(request.id, true)
  })
  services.sessions.start(session.id, '查询并清理凭据记忆')
  await services.sessions.waitForIdle(session.id)
  assert.equal(services.sessions.faultCount(), 0)
  assert.equal(services.memories.search({ scopeType: 'agent_character', scopeKey: '7' }).length, 0)
  assert.doesNotMatch(JSON.stringify(db.connection.prepare('SELECT request_json,result_json FROM tool_operations').all()), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(services.repository.checkpoint(session.id)), new RegExp(secret))
  for (const request of model.requests.slice(2)) assert.doesNotMatch(JSON.stringify(request.messages), new RegExp(secret))
  const exposed = services.repository.events.list(session.id, '0', 1000).filter(event => JSON.stringify(event.payload).includes(secret)).map(event => event.kind)
  assert.deepEqual(exposed, [], 'live audit events must hide credential text')
})
