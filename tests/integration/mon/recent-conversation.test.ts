import test from 'node:test'
import assert from 'node:assert/strict'
import type { MonClient } from '@eden/integrations'
import { readOwnerQqHistory } from '../../../src/modules/mon/contact-history.ts'
import { contactTools } from '../../../src/modules/mon/contact-tools.ts'
import { selfAwakeContextSchema } from '../../../src/modules/self-awake/context.ts'
import type { MonBindingService } from '../../../src/modules/mon/model-binding.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'

test('QQ history returns ten conversations in chronological order, grouping consecutive messages', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => [
    { id: i * 3 + 1, role: 'user', content: `hello-${i}` },
    { id: i * 3 + 2, role: 'user', content: `more-${i}` },
    { id: i * 3 + 3, role: 'assistant', content: `reply-${i}`, sender: 'private' },
  ]).flat().reverse()
  let pages = 0
  const client = { async get(url: string) {
    if (url.includes('management')) return { data: { bot_id: 'bot', default_send_target: { target_qq_number: '123456' } } }
    pages++
    assert.ok(url.includes('target_type=user'))
    assert.ok(url.includes('target_qq_number=123456'))
    return { data: { messages: pages === 1 ? messages.slice(0, 8) : messages.slice(8), has_more: pages === 1, next_before_id: pages === 1 ? 29 : null } }
  } } as unknown as MonClient
  const result = await readOwnerQqHistory(client, {}, new AbortController().signal) as { rounds: { messages: { content: string }[] }[] }
  assert.equal(pages, 2)
  assert.equal(result.rounds.length, 10)
  assert.equal(result.rounds[0]!.messages[0]!.content, 'hello-2')
  assert.equal(result.rounds[9]!.messages[2]!.content, 'reply-11')
  assert.doesNotMatch(JSON.stringify(result), /private/)
})

test('old contact aggregation is absent and recent chat reading obeys permissions', async () => {
  let reads = 0
  const mon = { recentConversation() { reads++; return { rounds: [] } } } as unknown as MonBindingService
  const permissions = { async request() { throw new Error('denied') } } as unknown as PermissionService
  const tools = contactTools(mon, permissions, 'session', 'turn')
  assert.equal(tools.some(tool => tool.name === 'read_contact_history'), false)
  assert.equal(selfAwakeContextSchema.safeParse({ section: 'recent_contacts' }).success, false)
  const recent = tools.find(tool => tool.name === 'read_recent_conversation')!
  await assert.rejects(recent.execute({}, { callId: 'call', signal: new AbortController().signal }), /denied/)
  assert.equal(reads, 0)
})
