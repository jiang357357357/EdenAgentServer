import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import { rpcMethods } from '@eden/api'
import { ModelService, ModelBindingRepository, ModelContextLimitRepository } from '../src/modules/models/index.ts'
import { SessionRepository, SessionService } from '../src/modules/sessions/index.ts'
import { modelRoutes } from '../src/transport/rpc/model.routes.ts'
import { accountKey, withAccount } from '../src/modules/accounts/index.ts'

const model = { id: 'fixture', provider: 'recorded', baseUrl: 'https://example.test/v1', apiKey: 'fixture-private-key', contextWindow: 262144, maxTokens: 4096 }
function service(db: EdenDatabase, origin: 'local' | 'mon') {
  return new ModelService(origin, origin === 'local' ? model : undefined,
    origin === 'mon' ? new ModelBindingRepository(db) : undefined, undefined, undefined, new ModelContextLimitRepository(db))
}
function update(models: ModelService, id: string, limit: number | null) {
  const current = models.contextInfo(id)
  return models.setContextLimit(id, limit, current.modelKey, current.revision)
}

for (const origin of ['local', 'mon'] as const) test(`${origin}: saved limit survives disk reopen, resets and stays within the conversation`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-context-limit-'))
  const filename = path.join(root, 'fixture.db')
  let db = new EdenDatabase(filename, origin)
  try {
    const sessions = new SessionRepository(db, origin), first = sessions.create('First'), second = sessions.create('Second')
    let models = service(db, origin)
    if (origin === 'mon') for (const id of [first.id, second.id]) models.bind(id, { model, entityId: 1, label: 'Fixture' })
    const info = update(models, first.id, 65536)
    assert.equal(info.contextWindow, 65536)
    assert.equal(info.inputBudget, 58163)
    assert.equal(models.resolve(first.id)?.contextWindow, 65536)
    assert.equal(models.read(first.id).contextWindow, 65536)
    assert.equal(models.resolve(second.id)?.contextWindow, 262144)
    assert.equal(models.resolve(first.id)?.maxTokens, 4096)
    assert.equal(JSON.stringify(info).includes('fixture-private-key'), false)
    db.close(); db = new EdenDatabase(filename, origin); models = service(db, origin)
    assert.equal(models.resolve(first.id)?.contextWindow, 65536)
    assert.equal(models.contextInfo(first.id).override, 65536)
    const reset = update(models, first.id, null)
    assert.equal(reset.contextWindow, 262144)
    assert.equal(reset.override, null)
    assert.ok(reset.revision)
  } finally {
    db.close()
    assert.equal(path.dirname(root), tmpdir())
    await rm(root, { recursive: true, force: true })
  }
})

test('all acting models and director use the budget; new provider limits and output reserve are respected', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const sessions = new SessionRepository(db, 'mon')
    const session = sessions.create('Actors', [{ assistantId: 1, characterId: 11 }, { assistantId: 2, characterId: 22 }]), models = service(db, 'mon')
    const actor = (id: number, contextWindow: number, maxTokens = 4096) => ({ assistantId: id, characterId: id * 11,
      main: { model: { ...model, id: `actor-${id}`, contextWindow, maxTokens }, entityId: id, label: `Actor ${id}` } })
    models.bindActors(session.id, [actor(1, 262144), actor(2, 131072)], model)
    const before = models.contextInfo(session.id)
    assert.equal(before.defaultContextWindow, 131072)
    update(models, session.id, 65536)
    assert.equal(models.resolveActorModel(session.id, 1)?.contextWindow, 65536)
    assert.equal(models.resolveActor(session.id, 2)?.main.model.contextWindow, 65536)
    assert.equal(models.resolveDirector(session.id)?.contextWindow, 65536)
    models.bindActors(session.id, [actor(1, 32768), actor(2, 131072)], model)
    assert.equal(models.resolveActorModel(session.id, 1)?.contextWindow, 32768)
    assert.equal(models.resolveActorModel(session.id, 2)?.contextWindow, 65536)
    assert.equal(models.contextInfo(session.id).contextWindow, 32768)
    update(models, session.id, 16384)
    models.bindActors(session.id, [actor(1, 131072, 32768), actor(2, 131072)], model)
    assert.ok(models.resolveActorModel(session.id, 1)!.contextWindow > 32768)
  } finally { db.close() }
})

test('out-of-range values, stale revisions, model changes and reset ABA cannot overwrite current settings', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const id = new SessionRepository(db, 'mon').create('CAS').id, models = service(db, 'mon')
    models.bind(id, { model, entityId: 1, label: 'Fixture' })
    const before = models.contextInfo(id)
    for (const limit of [0, -1, 8191, 1.5, 262145, Number.NaN]) assert.throws(() => update(models, id, limit), /整数/)
    update(models, id, 65536); update(models, id, null)
    assert.throws(() => models.setContextLimit(id, 32768, before.modelKey, before.revision), /已变化/)
    const now = models.contextInfo(id)
    models.bind(id, { model: { ...model, id: 'another-model' }, entityId: 2, label: 'New' })
    assert.throws(() => models.setContextLimit(id, 32768, now.modelKey, now.revision), /已变化/)
    assert.equal(models.resolve(id)?.contextWindow, 262144)
    assert.equal(rpcMethods['model.context.set'].params.safeParse({ sessionId: id, contextWindow: 1.2, expectedModelKey: now.modelKey, expectedRevision: null }).success, false)
  } finally { db.close() }
})

test('RPC checks ownership and rejects closed or executing sessions without changing their budget', async () => {
  const provider = await recordedModel([{ wait: true }])
  const db = new EdenDatabase(':memory:', 'local'), repository = new SessionRepository(db, 'local'), models = service(db, 'local')
  const sessions = new SessionService(repository, { ...provider.config, contextWindow: 262144 })
  try {
    const alice = { key: accountKey('https://example.test', 'alice'), userId: 'alice', coreBaseUrl: 'https://example.test' }
    const bob = { ...alice, key: accountKey(alice.coreBaseUrl, 'bob'), userId: 'bob' }
    const session = withAccount(alice, () => repository.create('Owned'))
    const routes = modelRoutes(models, sessions), current = models.contextInfo(session.id)
    const input = { sessionId: session.id, contextWindow: 65536, expectedModelKey: current.modelKey, expectedRevision: current.revision }
    await assert.rejects(async () => withAccount(bob, () => routes['model.context.read']!({ sessionId: session.id })), /当前账号/)
    await assert.rejects(async () => withAccount(bob, () => routes['model.context.set']!(input)), /当前账号/)
    await assert.rejects(async () => routes['model.context.read']!({ sessionId: randomUUID() }), /Session not found/)
    const closed = repository.create('Closed')
    repository.setStatus(closed.id, 'closed')
    await assert.rejects(async () => routes['model.context.set']!({ ...input, sessionId: closed.id }), /活动会话/)
    sessions.start(session.id, 'Wait for cancellation')
    await assert.rejects(async () => routes['model.context.set']!(input), /idle|排队消息/)
    assert.equal(models.contextInfo(session.id).override, null)
  } finally { await sessions.close(); db.close(); await provider.close() }
})

test('lowering the saved budget causes real pi request compaction on restored history', async () => {
  const provider = await recordedModel([{ text: 'A'.repeat(11000) }, { text: 'SUMMARY: old work complete' }, { text: 'Continued' }])
  const db = new EdenDatabase(':memory:', 'local')
  const models = new ModelService('local', provider.config, undefined, undefined, undefined, new ModelContextLimitRepository(db))
  const id = new SessionRepository(db, 'local').create('Runtime budget').id, record = callbacks()
  const runtime = createRuntime({ sessionId: id, systemPrompt: '', model: models.resolve(id)!, tools: [], callbacks: record.handlers })
  try {
    await runtime.prompt('OLD '.repeat(1750))
    update(models, id, 10000)
    const resumed = createRuntime({ sessionId: id, systemPrompt: '', model: models.resolve(id)!, tools: [], callbacks: record.handlers, checkpoint: await runtime.snapshot() })
    try {
      await resumed.prompt('CURRENT '.repeat(1000))
      assert.equal(provider.requests.length, 3)
      assert.match(JSON.stringify(provider.requests[1]), /OLD/)
      assert.match(JSON.stringify(provider.requests[2]), /SUMMARY: old work complete/)
      assert.match(JSON.stringify(provider.requests[2]), /CURRENT/)
      assert.doesNotMatch(JSON.stringify(provider.requests[2]), /A{1000}/)
      assert.ok((await resumed.snapshot()).entries.some(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.type === 'compaction'))
    } finally { await resumed.dispose?.() }
  } finally { await runtime.dispose?.(); db.close(); await provider.close() }
})
