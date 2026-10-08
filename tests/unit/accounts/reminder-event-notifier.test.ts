import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { DurableEvent } from '@eden/api'
import { reminderEventNotifier } from '../../../src/transport/websocket/reminder-event-notifier.ts'

function event(kind: string): DurableEvent {
  return { id: 'fixture', sessionId: 'fixture-session', turnId: null, seq: '1', kind,
    payload: { privateContent: 'Not part of the notification' }, createdAt: 1 }
}
test('reminder notifications coalesce changes and omit all session event payloads', async () => {
  const sent: unknown[] = []
  let resolve!: () => void, refreshes = 0
  const verification = new Promise<void>(yes => { resolve = yes })
  const publish = reminderEventNotifier('mon', () => { refreshes++; return verification }, () => true, value => sent.push(value))
  publish(event('agent.message_update')); assert.equal(refreshes, 0)
  publish(event('desktop.reminder.created')); publish(event('desktop.reminder.displayed')); publish(event('desktop.reminder.closed'))
  assert.equal(refreshes, 1); assert.deepEqual(sent, [])
  resolve(); await setImmediate()
  assert.deepEqual(sent, [{ jsonrpc: '2.0', method: 'desktop.reminder.changed', params: { runtimeOrigin: 'mon' } }])
  publish(event('desktop.reminder.created')); await setImmediate(); assert.equal(sent.length, 2)
})
test('connection closure during authentication suppresses the reminder notification', async () => {
  let active = true, resolve!: () => void
  const verification = new Promise<void>(yes => { resolve = yes }), sent: unknown[] = []
  const publish = reminderEventNotifier('mon', () => verification, () => active, value => sent.push(value))
  publish(event('desktop.reminder.created')); active = false; resolve(); await setImmediate()
  publish(event('desktop.reminder.closed')); assert.deepEqual(sent, [])
})
test('failed authentication never emits a reminder notification', async () => {
  const sent: unknown[] = []
  const publish = reminderEventNotifier('mon', async () => { throw new Error('Fixture account revoked') }, () => true, value => sent.push(value))
  publish(event('desktop.reminder.created')); await setImmediate(); assert.deepEqual(sent, [])
})
