import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { JsonValue } from '@eden/api'
import { StreamCoalescer } from '../../../src/modules/sessions/turn/stream-coalescer.ts'

function update(text: string, delta = text.at(-1)!, type = 'text_delta', contentIndex = 0) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] }
  return { messageId: 'message', message, assistantMessageEvent: { type, contentIndex, delta, partial: message } }
}

test('first update is immediate, sampling keeps the latest snapshot and aggregates every skipped delta', async () => {
  let now = 0
  const sent: JsonValue[] = []
  const stream = new StreamCoalescer((_kind, payload) => sent.push(payload), () => now)
  await stream.event('agent.message_update', update('a'))
  assert.equal(sent.length, 1)
  now = 99
  await stream.event('agent.message_update', update('ab'))
  assert.equal(sent.length, 1)
  now = 100
  await stream.event('agent.message_update', update('abc'))
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], update('abc', 'bc'))
  await stream.event('agent.message_update', update('abcd'))
  stream.flush()
  assert.deepEqual(sent[2], update('abcd'))
  stream.flush()
  assert.equal(sent.length, 3)
})

test('buffered SDK snapshots are copied and no deferred write runs after the owner stops', async () => {
  const sent: JsonValue[] = []
  const stream = new StreamCoalescer((_kind, payload) => sent.push(payload), () => 0)
  await stream.event('agent.message_update', update('a'))
  const mutable = update('ab')
  await stream.event('agent.message_update', mutable)
  mutable.message.content[0]!.text = 'mutated after callback'
  mutable.assistantMessageEvent.delta = 'wrong'
  stream.flush()
  assert.deepEqual(sent[1], update('ab'))
  await stream.event('agent.message_update', update('abc'))
  await setImmediate()
  await setImmediate()
  assert.equal(sent.length, 2, 'Without a new event/boundary there is no background write')
})

test('message, actor, delta type and content index boundaries never merge incompatible deltas', async () => {
  const sent: JsonValue[] = []
  const stream = new StreamCoalescer((_kind, payload) => sent.push(payload), () => 0)
  await stream.event('agent.message_update', update('a'))
  await stream.event('agent.message_update', update('ab'))
  await stream.event('agent.message_update', update('thinking', 'think', 'thinking_delta'))
  await stream.event('agent.message_update', update('thinking more', ' more', 'thinking_delta'))
  await stream.event('agent.message_update', update('next block', 'next', 'text_delta', 1))
  await stream.event('agent.message_update', { ...update('new message'), messageId: 'second' })
  await stream.event('agent.message_update', { ...update('actor'), messageId: 'second', actor: { assistantID: 2 } })
  assert.equal(sent.length, 7)
  assert.deepEqual(sent[1], update('ab'))
  assert.deepEqual(sent[3], update('thinking more', ' more', 'thinking_delta'))
})

test('non-delta updates are retained as semantic boundaries instead of being silently dropped', async () => {
  const sent: { kind: string; payload: JsonValue }[] = []
  const stream = new StreamCoalescer((kind, payload) => sent.push({ kind, payload }), () => 0)
  await stream.event('agent.message_update', update('a'))
  await stream.event('agent.message_update', update('ab'))
  const end = update('ab', '', 'text_end')
  await stream.event('agent.message_update', end)
  await stream.event('agent.message_end', { messageId: 'message', message: end.message })
  assert.equal(sent.length, 4)
  assert.deepEqual(sent[1]?.payload, update('ab'))
  assert.deepEqual(sent[2]?.payload, end)
  assert.equal(sent[3]?.kind, 'agent.message_end')
})
