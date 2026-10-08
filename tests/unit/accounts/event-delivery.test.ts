import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { DurableEvent, JsonValue } from '@eden/api'
import { AccountEventDelivery } from '../../../src/transport/websocket/account-event-delivery.ts'

type Range = { readonly sessionId: string; readonly afterSeq: string; readonly throughSeq: string }
type WireEvent = Pick<DurableEvent, 'id' | 'sessionId' | 'seq' | 'payload'>

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`)
    await setImmediate()
  }
}

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(local = false) {
  let active = false, calls = 0
  let sendHook = async (_value: WireEvent) => {}
  const verified = deferred()
  const persisted: DurableEvent[] = [], reads: Range[][] = [], sent: WireEvent[] = [], closes: { code: number; reason: string }[] = []
  const account = { active: () => active, refresh: () => { calls++; return verified.promise } }
  const readPending = (ranges: readonly Range[]) => {
    reads.push(ranges.map(range => ({ ...range })))
    return persisted.find(event => ranges.some(range => range.sessionId === event.sessionId
      && BigInt(event.seq) > BigInt(range.afterSeq) && BigInt(event.seq) <= BigInt(range.throughSeq)))
  }
  const delivery = new AccountEventDelivery(local ? undefined : account, async serialized => {
    const envelope = JSON.parse(serialized) as { jsonrpc: string; method: string; params: WireEvent }
    assert.equal(envelope.jsonrpc, '2.0')
    assert.equal(envelope.method, 'session.event')
    await sendHook(envelope.params)
    sent.push(envelope.params)
  }, (code, reason) => { closes.push({ code, reason }) }, readPending)
  const persist = (seq: string, payload: JsonValue = {}, sessionId = 'session-a') => {
    const event: DurableEvent = { id: `${sessionId}-${seq}`, sessionId, turnId: null, seq,
      kind: 'agent.message_update', payload, createdAt: persisted.length + 1 }
    persisted.push(event)
    return event
  }
  return { delivery, persisted, reads, sent, closes, persist, get calls() { return calls },
    publish(seq: string, payload: JsonValue = {}, sessionId?: string) { delivery.publish(persist(seq, payload, sessionId)) },
    allow() { active = true; verified.resolve() }, reject: verified.reject,
    activateBeforeResolution() { active = true }, finish: verified.resolve,
    send(action: typeof sendHook) { sendHook = action } }
}

test('verification holds durable cursors and shares refresh until ordered asynchronous delivery', async t => {
  const f = fixture()
  t.after(() => f.delivery.dispose())
  f.publish('1'); f.publish('2')
  const ready = f.delivery.refresh()
  assert.equal(f.calls, 1)
  assert.equal(f.reads.length, 0)
  assert.equal(f.sent.length, 0)
  f.allow()
  await ready
  await until(() => f.sent.length === 2, 'held events')
  f.publish('3')
  await until(() => f.sent.length === 3, 'live event')
  assert.deepEqual(f.sent.map(event => event.seq), ['1', '2', '3'])
  assert.equal(f.closes.length, 0)
})

test('an RPC publication before the refresh continuation cannot overtake durable held events', async t => {
  const f = fixture()
  t.after(() => f.delivery.dispose())
  f.publish('1'); f.publish('2')
  const ready = f.delivery.refresh()
  f.activateBeforeResolution()
  f.publish('3')
  f.finish()
  await ready
  await until(() => f.sent.length === 3, 'three ordered events')
  assert.deepEqual(f.sent.map(event => event.seq), ['1', '2', '3'])
  assert.equal(f.closes.length, 0)
})

test('failed verification never reads held payloads and permanently stops delivery', async () => {
  const f = fixture()
  f.publish('1')
  const failed = assert.rejects(f.delivery.refresh(), /identity changed/)
  f.reject(new Error('identity changed'))
  await failed
  f.activateBeforeResolution()
  f.publish('2')
  await setImmediate()
  assert.equal(f.reads.length, 0)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.closes.map(value => value.code), [1008])
})

for (const outcome of ['success', 'failure'] as const) {
  test(`disposing during verification prevents late ${outcome} from reading or sending held events`, async () => {
    const f = fixture()
    f.publish('1')
    const done = assert.rejects(f.delivery.refresh(), /closed|rejected/)
    f.delivery.dispose()
    if (outcome === 'success') f.allow()
    else f.reject(new Error('rejected'))
    await done
    f.publish('2')
    assert.equal(f.reads.length, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.closes.length, 0)
  })
}

test('more than 1024 events and 4 MiB are replayed from durable storage without caching published payloads', async t => {
  const f = fixture()
  t.after(() => f.delivery.dispose())
  for (let index = 1; index <= 1100; index++) {
    const event = f.persist(String(index), index === 550 ? { content: '中'.repeat(1_400_000) } : { index })
    const notice = Object.defineProperty({ ...event }, 'payload', {
      get() { throw new Error('publish must retain only durable cursors, not read payload') },
    })
    f.delivery.publish(notice)
  }
  assert.equal(f.reads.length, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.closes.length, 0)
  const ready = f.delivery.refresh()
  f.allow()
  await ready
  await until(() => f.sent.length === 1100, 'all oversized durable history')
  assert.deepEqual(f.sent.map(event => event.seq), Array.from({ length: 1100 }, (_, index) => String(index + 1)))
  assert.deepEqual(f.sent[549]?.payload, f.persisted[549]?.payload)
  assert.equal(f.closes.length, 0)
  assert.equal(f.calls, 1)
})

test('a blocked asynchronous send reads only one payload and advances ranges only after delivery', async t => {
  const f = fixture(), blocked = deferred()
  t.after(() => { blocked.resolve(); f.delivery.dispose() })
  let started = 0
  f.send(async event => { started++; if (event.seq === '20') await blocked.promise })
  f.publish('20'); f.publish('21'); f.publish('22')
  const ready = f.delivery.refresh()
  f.allow()
  await ready
  await until(() => started === 1, 'first in-flight send')
  f.publish('23')
  await setImmediate()
  assert.equal(f.reads.length, 1, 'No next event payload is fetched while the network send is blocked')
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.reads[0], [{ sessionId: 'session-a', afterSeq: '19', throughSeq: '22' }])
  blocked.resolve()
  await until(() => f.sent.length === 4, 'backpressured events')
  assert.deepEqual(f.sent.map(event => event.seq), ['20', '21', '22', '23'])
  assert.deepEqual(f.reads[1], [{ sessionId: 'session-a', afterSeq: '20', throughSeq: '23' }])
  assert.equal(f.closes.length, 0)
})

test('send failure closes once and does not fetch the next durable payload', async () => {
  const f = fixture()
  f.send(async () => { throw new Error('network send rejected') })
  f.publish('1'); f.publish('2')
  f.allow()
  await until(() => f.closes.length === 1, 'send failure close')
  f.publish('3')
  await setImmediate()
  assert.equal(f.reads.length, 1)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.closes.map(value => value.code), [1011])
})

test('reentrant asynchronous sends retain durable publication order', async t => {
  const f = fixture()
  t.after(() => f.delivery.dispose())
  f.send(async event => { if (event.seq === '1') f.publish('3') })
  f.publish('1'); f.publish('2')
  f.allow()
  await until(() => f.sent.length === 3, 'reentrant sends')
  assert.deepEqual(f.sent.map(event => event.seq), ['1', '2', '3'])
})

test('local delivery reads persisted events without requesting account verification', async t => {
  const f = fixture(true)
  t.after(() => f.delivery.dispose())
  f.publish('1')
  await until(() => f.sent.length === 1, 'local event')
  assert.equal(f.calls, 0)
  assert.deepEqual(f.sent.map(event => event.seq), ['1'])
})
