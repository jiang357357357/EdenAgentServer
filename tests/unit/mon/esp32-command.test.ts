import test from 'node:test'
import assert from 'node:assert/strict'
import { MonClient, MonHttpError } from '@eden/integrations'
import { issueEsp32Command } from '../../../src/modules/mon/esp32-command.ts'

test('ESP contact commands bind the session assistant before contacting Core', async () => {
  const client = new MonClient('http://127.0.0.1:1', 'fixture')
  const sent: unknown[] = []
  client.post = async (_endpoint, body) => { sent.push(body); return { accepted: true } }
  const signal = new AbortController().signal
  let resolvedClient = false
  await assert.rejects(issueEsp32Command(() => { resolvedClient = true; return client },
    { action: 'message.send', arguments: { assistant_id: 999 } }, () => undefined, signal), /Core 助手身份/)
  assert.equal(resolvedClient, false)
  const command = { action: 'message.send', arguments: { assistant_id: 999, text: 'hello' } }
  await issueEsp32Command(() => client, command, () => '123', signal)
  assert.deepEqual(sent[0], { action: 'message.send', arguments: { assistant_id: 123, text: 'hello' } })
  assert.equal(command.arguments.assistant_id, 999)
  await issueEsp32Command(() => client, { action: 'volume.set', arguments: { value: 10 } },
    () => { throw new Error('Non-contact commands must not resolve an assistant') }, signal)
  assert.equal(sent.length, 2)
})

test('ESP failures retain actionable HTTP errors and preserve unknown failures', async () => {
  const client = new MonClient('http://127.0.0.1:1', 'fixture')
  const signal = new AbortController().signal
  for (const [status, message] of [[404, '设备不存在'], [409, '设备当前离线'], [400, '拒绝了参数']] as const) {
    client.post = async () => { throw new MonHttpError(status) }
    await assert.rejects(issueEsp32Command(() => client, {}, () => undefined, signal), new RegExp(message))
  }
  const failure = new Error('connection failure')
  client.post = async () => { throw failure }
  await assert.rejects(issueEsp32Command(() => client, {}, () => undefined, signal), error => error === failure)
})
