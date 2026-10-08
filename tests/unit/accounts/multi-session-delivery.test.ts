import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { DurableEvent } from '@eden/api'
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

function connection() {
  let active = false, calls = 0, resolve!: () => void, reject!: (error: Error) => void
  const verified = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  let sendHook = async (_value: WireEvent) => {}
  const persisted: DurableEvent[] = [], sent: WireEvent[] = [], reads: Range[][] = [], closed: { code: number; reason: string }[] = []
  const delivery = new AccountEventDelivery({ active: () => active, refresh: () => { calls++; return verified } },
    async serialized => {
      const value = JSON.parse(serialized).params as WireEvent
      await sendHook(value)
      sent.push(value)
    }, (code, reason) => { closed.push({ code, reason }) }, (ranges: readonly Range[]) => {
      reads.push(ranges.map(range => ({ ...range })))
      return persisted.find(event => ranges.some(range => event.sessionId === range.sessionId
        && BigInt(event.seq) > BigInt(range.afterSeq) && BigInt(event.seq) <= BigInt(range.throughSeq)))
    })
  const publish = (sessionId: string, seq: string, content = `${sessionId}:${seq}`) => {
    const event: DurableEvent = { id: `${sessionId}-${seq}`, sessionId, turnId: null, seq,
      kind: 'agent.message_update', payload: { content }, createdAt: persisted.length + 1 }
    persisted.push(event)
    delivery.publish(event)
    return event
  }
  return { delivery, persisted, sent, reads, closed, publish, get calls() { return calls },
    allow() { active = true; resolve() }, reject, send(action: typeof sendHook) { sendHook = action } }
}

test('interleaved session cursors retain global durable order and independent large sequence numbers', async t => {
  const client = connection()
  t.after(() => client.delivery.dispose())
  const events = [client.publish('session-a', '100'), client.publish('session-b', '1'),
    client.publish('session-c', '9007199254740993'), client.publish('session-a', '101'),
    client.publish('session-b', '2'), client.publish('session-c', '9007199254740994')]
  const ready = client.delivery.refresh()
  assert.equal(client.calls, 1)
  assert.equal(client.reads.length, 0)
  client.allow()
  await ready
  await until(() => client.sent.length === 6, 'interleaved held events')
  events.push(client.publish('session-b', '3'), client.publish('session-a', '102'), client.publish('session-c', '9007199254740995'))
  await until(() => client.sent.length === 9, 'live events from all sessions')
  assert.deepEqual(client.sent.map(event => event.id), events.map(event => event.id))
  const sequences = (id: string) => client.sent.filter(event => event.sessionId === id).map(event => event.seq)
  assert.deepEqual(sequences('session-a'), ['100', '101', '102'])
  assert.deepEqual(sequences('session-b'), ['1', '2', '3'])
  assert.deepEqual(sequences('session-c'), ['9007199254740993', '9007199254740994', '9007199254740995'])
  assert.equal(new Set(client.sent.map(event => event.id)).size, 9)
  assert.equal(client.closed.length, 0)
})

test('two connections refresh independently even with overlapping session identifiers', async t => {
  const first = connection(), second = connection()
  t.after(() => { first.delivery.dispose(); second.delivery.dispose() })
  const firstEvents = [first.publish('shared-session', '50'), first.publish('first-only', '10')]
  const secondEvents = [second.publish('second-only', '600'), second.publish('shared-session', '51')]
  const firstReady = first.delivery.refresh(), secondReady = second.delivery.refresh()
  assert.notEqual(firstReady, secondReady)
  second.allow()
  await secondReady
  secondEvents.push(second.publish('second-only', '601'))
  await until(() => second.sent.length === 3, 'second connection')
  assert.equal(first.sent.length, 0)
  assert.equal(first.reads.length, 0)
  assert.deepEqual(second.sent.map(event => event.id), secondEvents.map(event => event.id))
  first.allow()
  await firstReady
  await until(() => first.sent.length === 2, 'first connection')
  assert.deepEqual(first.sent.map(event => event.id), firstEvents.map(event => event.id))
  assert.equal(first.calls, 1)
  assert.equal(second.calls, 1)
  assert.equal(first.closed.length, 0)
  assert.equal(second.closed.length, 0)
})

test('authentication failure discards only that connection’s session cursors', async t => {
  const denied = connection(), healthy = connection()
  t.after(() => { denied.delivery.dispose(); healthy.delivery.dispose() })
  denied.publish('denied-a', '30'); denied.publish('denied-b', '1')
  const events = [healthy.publish('healthy-a', '99'), healthy.publish('healthy-b', '7')]
  const rejected = assert.rejects(denied.delivery.refresh(), /fixture account rejected/)
  const ready = healthy.delivery.refresh()
  denied.reject(new Error('fixture account rejected'))
  await rejected
  assert.equal(denied.reads.length, 0)
  assert.equal(denied.sent.length, 0)
  assert.deepEqual(denied.closed.map(value => value.code), [1008])
  assert.equal(healthy.closed.length, 0)
  healthy.allow()
  await ready
  events.push(healthy.publish('healthy-b', '8'))
  await until(() => healthy.sent.length === 3, 'healthy connection after peer rejection')
  denied.allow()
  denied.publish('denied-a', '31')
  assert.deepEqual(healthy.sent.map(event => event.id), events.map(event => event.id))
  assert.equal(denied.sent.length, 0)
  assert.equal(healthy.closed.length, 0)
})

test('a blocked connection with oversized multi-session history does not block a healthy connection', async t => {
  const slow = connection(), healthy = connection()
  let release!: () => void, started = false
  const blocked = new Promise<void>(resolve => { release = resolve })
  t.after(() => { release(); slow.delivery.dispose(); healthy.delivery.dispose() })
  slow.send(async () => { if (!started) { started = true; await blocked } })
  for (let index = 1; index <= 1100; index++)
    slow.publish(`slow-${index % 3}`, String(1 + (index % 3) * 1000 + Math.floor((index - 1) / 3)),
      index === 600 ? '中'.repeat(1_400_000) : String(index))
  const healthyEvents = [healthy.publish('healthy-a', '500'), healthy.publish('healthy-b', '1')]
  const slowReady = slow.delivery.refresh(), healthyReady = healthy.delivery.refresh()
  slow.allow(); healthy.allow()
  await Promise.all([slowReady, healthyReady])
  await until(() => started && healthy.sent.length === 2, 'healthy delivery while peer is blocked')
  healthyEvents.push(healthy.publish('healthy-a', '501'))
  await until(() => healthy.sent.length === 3, 'healthy live event')
  assert.equal(slow.sent.length, 0)
  assert.equal(slow.reads.length, 1)
  assert.deepEqual(healthy.sent.map(event => event.id), healthyEvents.map(event => event.id))
  assert.equal(slow.closed.length, 0)
  assert.equal(healthy.closed.length, 0)
  release()
  await until(() => slow.sent.length === 1100, 'oversized multi-session durable history')
  assert.deepEqual(slow.sent.map(event => event.id), slow.persisted.map(event => event.id))
  assert.equal(slow.closed.length, 0)
  assert.equal(healthy.closed.length, 0)
})

test('disposing one blocked connection does not stop another connection’s durable replay', async t => {
  const disposed = connection(), healthy = connection()
  let release!: () => void, started = false
  const blocked = new Promise<void>(resolve => { release = resolve })
  t.after(() => { release(); disposed.delivery.dispose(); healthy.delivery.dispose() })
  disposed.send(async () => { started = true; await blocked })
  disposed.publish('disposed-a', '1'); disposed.publish('disposed-b', '50')
  disposed.allow()
  await until(() => started, 'in-flight send')
  disposed.delivery.dispose()
  release()
  const event = healthy.publish('healthy', '200')
  healthy.allow()
  await until(() => healthy.sent.length === 1, 'healthy replay after peer disposal')
  await setImmediate()
  assert.equal(disposed.reads.length, 1, 'An already-started send may finish, but no next payload is read')
  assert.deepEqual(healthy.sent.map(value => value.id), [event.id])
  assert.equal(disposed.closed.length, 0)
  assert.equal(healthy.closed.length, 0)
})
