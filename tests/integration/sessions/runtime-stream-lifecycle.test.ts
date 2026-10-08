import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { createRuntime } from '@eden/runtime-pi'
import type { DurableEvent, JsonValue } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { runtimeCallbacks } from '../../../src/modules/sessions/turn/runtime-callbacks.ts'

function update(text: string) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  return { message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x', partial: message } }
}

test('file-backed FULL synchronous SQLite handles 6000 real-clock updates without one transaction per token', async t => {
  const temporary = path.resolve(os.tmpdir())
  const root = await mkdtemp(path.join(temporary, 'eden-stream-coalescing-'))
  const database = new EdenDatabase(path.join(root, 'events.db'), 'local')
  t.after(async () => {
    database.close()
    assert.equal(path.dirname(path.resolve(root)), temporary)
    assert.ok(path.basename(root).startsWith('eden-stream-coalescing-'))
    await rm(root, { recursive: true, force: true })
  })
  const repository = new SessionRepository(database, 'local'), session = repository.create('Disk stream')
  const input = { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'fixture', state: 'running' }
  const callbacks = runtimeCallbacks(repository, input)
  const received: DurableEvent[] = []
  repository.events.subscribe(event => received.push(event))
  let transactions = 0
  const transaction = database.transaction.bind(database)
  t.mock.method(database, 'transaction', <T>(operation: () => T): T => { transactions++; return transaction(operation) })
  const started = performance.now()
  await callbacks.event('message_start', { message: { role: 'assistant', content: [] } })
  for (let index = 1; index <= 6000; index++) await callbacks.event('message_update', update('x'.repeat(index)))
  await callbacks.event('message_end', { message: update('x'.repeat(6000)).message })
  const elapsed = performance.now() - started
  const updates = received.filter(event => event.kind === 'agent.message_update')
  assert.ok(updates.length <= Math.ceil(elapsed / 100) + 2, 'Only cadence snapshots plus a final boundary flush are persisted')
  assert.ok(updates.length < 100, 'Thousands of provider chunks must not create thousands of disk transactions')
  assert.equal(transactions, updates.length + 2)
  assert.deepEqual(repository.events.list(session.id, '1', 1000), received)
  assert.deepEqual(received.map(event => event.seq), received.map((_event, index) => String(index + 2)))
  assert.deepEqual((received.at(-1)!.payload as Record<string, JsonValue>).message, update('x'.repeat(6000)).message)
  t.diagnostic(JSON.stringify({ chunks: 6000, durableUpdates: updates.length, transactions,
    elapsedMs: Math.round(elapsed), synchronous: database.connection.prepare('PRAGMA synchronous').get()?.synchronous }))
})

test('aborting a real pi HTTP stream flushes its final pending snapshot and leaves no late database writes',
  { timeout: 15000 }, async t => {
    t.mock.method(performance, 'now', () => 0)
    const database = new EdenDatabase(':memory:', 'local')
    const repository = new SessionRepository(database, 'local'), session = repository.create('Cancelled stream')
    const input = { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'fixture', state: 'running' }
    const callbacks = runtimeCallbacks(repository, input)
    const received: DurableEvent[] = []
    repository.events.subscribe(event => received.push(event))
    let response: ServerResponse | undefined
    const model = createServer(async (request, outgoing) => {
      for await (const _chunk of request) { /* Drain only this local fixture request. */ }
      response = outgoing
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown) => outgoing.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
        created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      chunk({ role: 'assistant' })
      for (let index = 0; index < 200; index++) chunk({ content: 'x' })
      outgoing.flushHeaders()
    })
    model.listen(0, '127.0.0.1')
    await once(model, 'listening')
    const address = model.address()
    assert.ok(address && typeof address !== 'string')
    let observed!: () => void
    const streamed = new Promise<void>(resolve => { observed = resolve })
    let chunks = 0
    const runtime = createRuntime({ sessionId: session.id, systemPrompt: '', tools: [],
      model: { provider: 'fixture', id: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 32000, maxTokens: 1024 },
      modelRetry: { maxRetries: 0 }, callbacks: { ...callbacks, async event(kind, payload) {
        await callbacks.event(kind, payload)
        const value = payload as Record<string, JsonValue>, stream = value.assistantMessageEvent as Record<string, JsonValue> | undefined
        if (kind === 'message_update' && stream?.type === 'text_delta' && ++chunks === 200) observed()
      } } })
    t.after(async () => {
      await runtime.abort()
      response?.destroy()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      database.close()
    })
    const running = runtime.prompt('Stream until cancelled')
    const outcome = running.then(() => undefined, error => error)
    await streamed
    await runtime.abort()
    await outcome
    const updates = received.filter(event => event.kind === 'agent.message_update')
    const last = updates.at(-1)!.payload as Record<string, JsonValue>
    const message = last.message as Record<string, JsonValue>
    const text = (message.content as Record<string, JsonValue>[]).find(part => part.type === 'text')?.text
    assert.equal(text, 'x'.repeat(200))
    assert.ok(updates.length < 10)
    const count = received.length
    await setImmediate()
    await setImmediate()
    assert.equal(received.length, count)
    assert.deepEqual(repository.events.list(session.id, '1', 1000), received)
  })
