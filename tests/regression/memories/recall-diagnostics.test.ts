import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { MonHttpError } from '@eden/integrations'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { MemoryRecall, MemoryRepository, MemoryScopes } from '../../../src/modules/memories/index.ts'
import type { MemoryRetriever } from '../../../src/modules/memories/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { configureLogging, loggingFile } from '../../../src/modules/logging/logger.ts'

const account = { userId: 'memory-diagnostics', coreBaseUrl: 'http://localhost:40011', key: accountKey('http://localhost:40011', 'memory-diagnostics') }
const scope = { scopeType: 'agent_character' as const, scopeKey: '11' }

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-memory-diagnostics-'))
  const options = { origin: 'mon' as const, dataRoot: root, env: { EDEN_AGENT_LOG_FORMAT: 'json' } }
  const logger = configureLogging(options), database = new EdenDatabase(':memory:', 'mon')
  context.after(async () => { logger.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const sessions = new SessionRepository(database, 'mon'), memories = new MemoryRepository(database)
  const session = sessions.create('memory fixture', [{ assistantId: 1, characterId: 11 }])
  const inputs = new InputRepository(database, sessions.events)
  inputs.enqueue(session.id, 'PRIVATE_QUERY_CONTENT', 'fixture', { participants: session.participants })
  const input = inputs.claim(session.id)!
  const memory = memories.create(scope, 'PRIVATE_MEMORY_CONTENT 用户喜欢清淡菜式。')
  return { session, input, memory,
    recall: (retrieve: MemoryRetriever) => new MemoryRecall(memories, new MemoryScopes(database), retrieve),
    logs: async () => (await readFile(loggingFile(options), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) }
}

test('Core failure details are actionable without logging private request or response content', async context => withAccount(account, async () => {
  const f = await fixture(context)
  const error = new MonHttpError(503, '/api/agent/memories/retrieve/', {
    reason: 'model_missing', query: 'PRIVATE_QUERY_CONTENT', document: 'PRIVATE_MEMORY_CONTENT', detail: 'PRIVATE_ERROR_DETAIL', token: 'PRIVATE_TOKEN',
  })
  const prompt = await f.recall(async () => { throw error }).prompt(f.session.id, f.input.turnId, 'PRIVATE_QUERY_CONTENT')
  assert.match(prompt, /自动长期记忆召回暂时不可用/)
  assert.match(prompt, /可调用记忆检索工具/)
  const logs = await f.logs(), failure = logs.find(record => record.event === 'memory.recall.unavailable')!
  assert.equal(logs[0]!.event, 'memory.recall.started')
  assert.equal(failure.status, 503)
  assert.equal(failure.coreReason, 'model_missing')
  assert.equal(failure.characterId, '11')
  assert.equal(failure.sessionId, f.session.id)
  assert.equal(failure.candidateCount, 1)
  assert.equal(typeof failure.durationMs, 'number')
  assert.doesNotMatch(JSON.stringify(logs) + prompt, /PRIVATE_(?:QUERY_CONTENT|MEMORY_CONTENT|ERROR_DETAIL|TOKEN)/)
}))

test('a transient failed lookup recovers on the next call without a sticky unavailable state', async context => withAccount(account, async () => {
  const f = await fixture(context)
  let calls = 0
  const recall = f.recall(async () => {
    if (++calls === 1) throw new MonHttpError(503, '/api/agent/memories/retrieve/', { reason: 'embedding_unavailable' })
    return [{ id: f.memory.id, similarity: 1, excerpt: '用户喜欢清淡菜式。' }]
  })
  assert.match(await recall.prompt(f.session.id, f.input.turnId, '晚餐'), /暂时不可用/)
  const recovered = await recall.prompt(f.session.id, f.input.turnId, '晚餐')
  assert.match(recovered, /用户喜欢清淡菜式/)
  assert.doesNotMatch(recovered, /暂时不可用/)
  const success = (await f.logs()).find(record => record.event === 'memory.recall.completed')!
  assert.equal(success.matchCount, 1)
  assert.equal(success.result, 'matched')
}))

test('an irrelevant query produces a no-match diagnostic and no unavailable prompt', async context => withAccount(account, async () => {
  const f = await fixture(context)
  assert.equal(await f.recall(async () => []).prompt(f.session.id, f.input.turnId, '你好'), '')
  const logs = await f.logs()
  assert.equal(logs.at(-1)!.event, 'memory.recall.completed')
  assert.equal(logs.at(-1)!.result, 'no_match')
  assert.equal(logs.at(-1)!.matchCount, 0)
  assert.ok(logs.every(record => record.event !== 'memory.recall.unavailable'))
}))

test('timeout, invalid selection and caller cancellation have distinct diagnostic facts', async context => withAccount(account, async () => {
  const f = await fixture(context)
  await f.recall(async () => { throw new DOMException('PRIVATE_TIMEOUT', 'TimeoutError') }).prompt(f.session.id, f.input.turnId, 'query')
  await f.recall(async () => [{ id: f.memory.id, similarity: 1, excerpt: 'fabricated content' }]).prompt(f.session.id, f.input.turnId, 'query')
  const controller = new AbortController()
  await assert.rejects(f.recall(async () => { controller.abort(); return [] }).prompt(f.session.id, f.input.turnId, 'query', undefined, controller.signal), /abort/i)
  const logs = await f.logs()
  assert.deepEqual(logs.filter(record => record.event === 'memory.recall.unavailable').map(record => record.errorCode), ['retrieval_timeout', 'invalid_selection'])
  assert.equal(logs.at(-1)!.event, 'memory.recall.cancelled')
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_TIMEOUT|fabricated content/)
}))
