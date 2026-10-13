import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { createIsolatedRuntime, isRuntimePersistenceFailure, type RuntimeOptions } from '@eden/runtime-pi'
import type { JsonValue, DurableEvent } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { runtimeCallbacks } from '../../../src/modules/sessions/turn/runtime-callbacks.ts'
import { processStreamModel } from './process-stream-model.ts'

type Payload = Record<string, JsonValue>
const isolated = (options: RuntimeOptions) => createIsolatedRuntime(options,
  process.env.EDEN_TEST_COMPILED_RUNTIME === '1' ? { entry: new URL('../../../../dist/server/runtime-process.mjs', import.meta.url) } : {})
function fixture(t: TestContext, onDisk = false) {
  const directory = onDisk ? mkdtempSync(path.join(os.tmpdir(), 'eden-stream-disk-')) : undefined
  const filename = directory ? path.join(directory, 'events.db') : ':memory:'
  const database = new EdenDatabase(filename, 'local')
  const repository = new SessionRepository(database, 'local')
  const session = repository.create('Process stream fixture')
  const input = { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'fixture', state: 'running' }
  const events: DurableEvent[] = []
  repository.events.subscribe(event => events.push(event))
  t.after(() => {
    database.close()
    if (directory) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  return { database, filename, repository, session, input, events, callbacks: runtimeCallbacks(repository, input) }
}

test('megabyte thinking and arguments persist with FULL durability and replay after a real database reopen', { timeout: 30000 }, async t => {
  const f = fixture(t, true), model = await processStreamModel('tool', 64, 8192)
  const characters = 64 * 8192
  let writes = 0, ticks = 0
  const interval = setInterval(() => ticks++, 25)
  const runtime = isolated({ sessionId: f.session.id, systemPrompt: 'fixture',
    model: { ...model.config, contextWindow: 4_000_000, maxTokens: 1_000_000 },
    tools: [{ name: 'write_once', description: 'fixture', revision: '1', parameters: { type: 'object', properties: { value: { type: 'string' } } },
      async execute(input) { assert.equal(input.value, '文'.repeat(characters)); writes++; return { completed: true } } }],
    callbacks: { ...f.callbacks, async event(kind, payload, delivery) {
      // Reproduce an SDK version adding fields only to partial, which used to disable compaction.
      if (kind === 'message_update') {
        const value = payload as Payload, stream = value.assistantMessageEvent as Payload
        stream.partial = { ...(stream.partial as Payload), sdkOnly: true }
      }
      await f.callbacks.event(kind, payload, delivery)
      if (delivery?.coalesced) await delay(40)
    } }, modelRetry: { maxRetries: 0 } })
  t.after(async () => { clearInterval(interval); await runtime.dispose(); await model.close() })
  const started = performance.now()
  await runtime.prompt('fixture')
  clearInterval(interval)
  assert.equal(writes, 1)
  assert.equal(model.requests, 2)
  assert.ok(ticks >= 2)
  const updates = f.events.filter(event => event.kind === 'agent.message_update')
  assert.equal(updates.filter(event => delta(event)?.type === 'thinking_delta').map(event => delta(event)!.delta).join(''), '想'.repeat(characters))
  assert.equal(updates.filter(event => delta(event)?.type === 'toolcall_delta').map(event => delta(event)!.delta).join(''), JSON.stringify({ value: '文'.repeat(characters) }))
  const original = updates.reduce((size, event) => size + Buffer.byteLength(JSON.stringify(event.payload)), 0)
  const stored = Number(f.database.connection.prepare("SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM events WHERE kind='agent.message_update'").get()!.bytes)
  assert.ok(stored < original / 2, `${stored} vs ${original}`)
  assert.equal(f.database.connection.prepare('PRAGMA synchronous').get()!.synchronous, 2)
  const reopened = new EdenDatabase(f.filename, 'local')
  try {
    assert.deepEqual(new SessionRepository(reopened, 'local').events.list(f.session.id, '1', 1000), f.events)
    assert.equal(reopened.connection.prepare("SELECT value FROM realm_meta WHERE key='event_payload_format'").get()!.value, 'eden.message.delta.v2')
  } finally { reopened.close() }
  t.diagnostic(JSON.stringify({ outputBytes: characters * 6, batches: updates.length, originalBytes: original, storedBytes: stored,
    elapsedMs: Math.round(performance.now() - started), hostTicks: ticks, toolExecutions: writes }))
})

function delta(event: DurableEvent) {
  return (event.payload as Payload).assistantMessageEvent as Payload | undefined
}

test('real child, slow ACK and SQLite preserve long thinking and tool arguments with one tool execution', { timeout: 20000 }, async t => {
  const f = fixture(t), model = await processStreamModel('tool')
  let writes = 0, deliveries = 0, modelFinishedAt = 0, toolStartedAt = 0
  const runtime = isolated({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config,
    tools: [{ name: 'write_once', description: 'fixture', revision: '1',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      async execute(value) {
        assert.equal(value.value, '文'.repeat(model.tokens)); writes++
        return { completed: true }
      } }], callbacks: { ...f.callbacks,
      async event(kind, payload, delivery) {
        await f.callbacks.event(kind, payload, delivery)
        if (kind === 'message_update' && delivery?.coalesced) { deliveries++; await delay(150) }
      },
      async response(snapshot) { modelFinishedAt ||= performance.now(); await f.callbacks.response!(snapshot) },
      async beforeTool(...args) { toolStartedAt = performance.now(); await f.callbacks.beforeTool!(...args) },
    }, modelRetry: { maxRetries: 0 } })
  t.after(async () => { await runtime.dispose(); await model.close() })
  const started = performance.now()
  await runtime.prompt('fixture')
  const elapsed = performance.now() - started
  assert.equal(writes, 1)
  assert.equal(model.requests, 2)
  assert.ok(deliveries < 30, `800+ raw deltas generated ${deliveries} acknowledged batches`)
  const updates = f.events.filter(event => event.kind === 'agent.message_update')
  assert.equal(updates.filter(event => delta(event)?.type === 'thinking_delta').map(event => delta(event)!.delta).join(''), '想'.repeat(model.tokens))
  assert.equal(updates.filter(event => delta(event)?.type === 'toolcall_delta').map(event => delta(event)!.delta).join(''), JSON.stringify({ value: '文'.repeat(model.tokens) }))
  assert.equal(updates.filter(event => delta(event)?.type === 'text_delta').map(event => delta(event)!.delta).join(''), 'fixture done')
  const finalMessage = (f.events.filter(event => event.kind === 'agent.message_end').at(-1)!.payload as Payload).message as Payload
  assert.match(JSON.stringify(finalMessage.content), /fixture done/)
  assert.equal(f.events.filter(event => event.kind === 'operation.started').length, 1)
  assert.equal(f.events.filter(event => event.kind === 'operation.completed').length, 1)
  assert.ok(toolStartedAt - modelFinishedAt < 5000, 'Tool dispatch waits for bounded batches, not hundreds of raw ACKs')
  assert.deepEqual(f.repository.events.list(f.session.id, '1', 1000), f.events)
  assert.deepEqual(f.events.map(event => event.seq), f.events.map((_event, index) => String(index + 2)))
  assert.ok(updates.every(event => !('coalesced' in (event.payload as Payload))), 'Private delivery metadata never persists')
  const count = f.events.length
  await delay(250)
  assert.equal(f.events.length, count)
  t.diagnostic(JSON.stringify({ rawDeltas: model.tokens * 2 + 24, deliveries, elapsedMs: Math.round(elapsed), toolDispatchMs: Math.round(toolStartedAt - modelFinishedAt) }))
})

test('two real children with slow confirmations keep separate sessions and both tools progress', { timeout: 25000 }, async t => {
  const fixtures = [fixture(t), fixture(t)], models = [await processStreamModel('tool', 120), await processStreamModel('tool', 120)]
  const counts = [0, 0]
  const runtimes = fixtures.map((f, index) => isolated({ sessionId: f.session.id, systemPrompt: 'fixture', model: models[index]!.config,
    tools: [{ name: 'write_once', description: 'fixture', revision: '1', parameters: { type: 'object', properties: { value: { type: 'string' } } },
      async execute(value) { assert.equal(value.value, '文'.repeat(120)); counts[index]!++; return { completed: true } } }],
    callbacks: { ...f.callbacks, async event(kind, payload, delivery) {
      await f.callbacks.event(kind, payload, delivery)
      if (delivery?.coalesced) await delay(150)
    } }, modelRetry: { maxRetries: 0 } }))
  t.after(async () => { await Promise.all(runtimes.map(runtime => runtime.dispose())); await Promise.all(models.map(model => model.close())) })
  await Promise.all(runtimes.map(runtime => runtime.prompt('fixture')))
  assert.deepEqual(counts, [1, 1])
  for (const f of fixtures) {
    assert.ok(f.events.every(event => event.sessionId === f.session.id))
    assert.equal(f.events.filter(event => delta(event)?.type === 'thinking_delta').map(event => delta(event)!.delta).join(''), '想'.repeat(120))
    assert.ok(f.events.filter(event => event.kind === 'agent.message_update').length < 25)
  }
})

test('cancelling a stalled provider drains accepted stream batches and causes no late writes', { timeout: 15000 }, async t => {
  const f = fixture(t), model = await processStreamModel('wait', 80)
  let observed!: () => void
  const ready = new Promise<void>(resolve => { observed = resolve })
  const runtime = isolated({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config, tools: [],
    callbacks: { ...f.callbacks, async event(kind, payload, delivery) {
      await f.callbacks.event(kind, payload, delivery)
      const updates = f.events.filter(event => delta(event)?.type === 'thinking_delta')
      if (updates.map(event => delta(event)!.delta).join('').length === 80) observed()
    } }, modelRetry: { maxRetries: 0 } })
  t.after(async () => { await runtime.dispose(); await model.close() })
  const task = runtime.prompt('fixture').catch(error => error)
  await ready
  await runtime.abort(); await task
  assert.equal(f.events.filter(event => delta(event)?.type === 'thinking_delta').map(event => delta(event)!.delta).join(''), '想'.repeat(80))
  const count = f.events.length
  await delay(250)
  assert.equal(f.events.length, count)
  assert.equal(f.events.filter(event => event.kind === 'operation.started').length, 0)
})

for (const mode of ['wait', 'tool'] as const) {
test(`SQLite stream failure interrupts a ${mode} model and permits no tool side effect`, { timeout: 15000 }, async t => {
  const f = fixture(t), model = await processStreamModel(mode, 80)
  f.database.connection.exec("CREATE TRIGGER reject_batch BEFORE INSERT ON events WHEN NEW.kind='agent.message_update' BEGIN SELECT RAISE(ABORT, 'disk rejected batch'); END")
  let writes = 0
  const runtime = isolated({ sessionId: f.session.id, systemPrompt: 'fixture', model: model.config,
    tools: [{ name: 'write_once', description: 'fixture', revision: '1', parameters: { type: 'object', properties: {} },
      async execute() { writes++; return { completed: true } } }],
    callbacks: f.callbacks, modelRetry: { maxRetries: 0 } })
  t.after(async () => { await runtime.dispose(); await model.close() })
  await assert.rejects(runtime.prompt('fixture'), error => isRuntimePersistenceFailure(error))
  assert.equal(writes, 0)
  assert.equal(model.requests, 1)
  assert.equal(f.events.filter(event => event.kind === 'operation.started').length, 0)
  const count = f.events.length
  await delay(250)
  assert.equal(f.events.length, count)
})
}
