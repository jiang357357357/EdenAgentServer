import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'
import { runtimeCallbacks } from '../src/modules/sessions/turn/runtime-callbacks.ts'
import { requestContext, estimateRequestTokens } from '../src/modules/sessions/turn/request-context.ts'

const participant = { assistantId: 'alice', profile: '爱丽丝，温柔而认真' }
const snapshot = (text = '你好', model = 'flash') => ({ requestId: 'request', model, provider: 'test',
  promptHints: [{ name: 'list_skills', text: 'Skill catalog: demo' }],
  payload: { messages: [{ role: 'system', content: `Rules\n${JSON.stringify(participant)}\nSkill catalog: demo` },
    { role: 'user', content: text }], tools: [{ type: 'function', function: { name: 'read_file' } }] } })
const metadata = { participants: [participant] }

test('actual prompt sections are counted once and empty tools are zero', () => {
  const result = requestContext(snapshot(), metadata, undefined)
  assert.equal(result.character, estimateRequestTokens(JSON.stringify(participant)))
  assert.equal(result.skills, estimateRequestTokens('Skill catalog: demo'))
  assert.equal(result.system, estimateRequestTokens('Rules\n\n'))
  assert.ok(Number(result.history) > 0)
  assert.equal(requestContext({ payload: { messages: [] } }, {}, undefined).tools, 0)
})
test('growing conversation preserves prefix while model and tool changes advance epoch', () => {
  const initial = requestContext(snapshot(), metadata, undefined)
  const stable = requestContext(snapshot('another message'), metadata, initial)
  assert.equal(stable.promptCacheEpoch, 1)
  assert.equal(stable.promptCacheInvalidationReason, 'stable')
  const changed = requestContext(snapshot('another message', 'different'), metadata, stable)
  assert.equal(changed.promptCacheEpoch, 2)
  const next = snapshot(); next.payload.tools = []
  assert.equal(requestContext(next, metadata, changed).promptCacheEpoch, 3)
})
test('request response association and recreated callbacks preserve estimates and prefix', async () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const repository = new SessionRepository(db, 'mon'), session = repository.create('context')
    const input = { sessionId: session.id, turnId: null, text: 'hello', metadata }
    // No active turn is needed to persist these synthetic request/response events.
    const callbacks = runtimeCallbacks(repository, input as unknown as Parameters<typeof runtimeCallbacks>[1])
    await callbacks.request(snapshot())
    await callbacks.response!({ requestId: 'request', message: { usage: { input: 431, cacheRead: 92032, cacheWrite: 0, output: 2223 } } })
    const restored = new SessionRepository(db, 'mon').read(session.id)
    assert.ok(Number((restored.tokenBreakdown as Record<string, unknown>).character) > 0)
    const recreated = runtimeCallbacks(repository, input as unknown as Parameters<typeof runtimeCallbacks>[1])
    await recreated.request(snapshot('next'))
    await recreated.response!({ requestId: 'request', message: { usage: { input: 1, output: 1 } } })
    assert.equal((repository.read(session.id).tokenBreakdown as Record<string, unknown>).promptCacheInvalidationReason, 'stable')
  } finally { db.connection.close() }
})
test('inline image bytes are excluded from text estimates', () => {
  assert.equal(estimateRequestTokens({ image_url: { url: 'x'.repeat(100000) } }), estimateRequestTokens({ image_url: { url: 'short' } }))
})
