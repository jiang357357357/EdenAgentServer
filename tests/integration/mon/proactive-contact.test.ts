import { ownerQqTarget } from '../../../src/modules/mon/qq-contact.ts'
import type { MonClient } from '@eden/integrations'
import test from 'node:test'
import assert from 'node:assert/strict'
import { contactTools } from '../../../src/modules/mon/contact-tools.ts'
import type { MonBindingService } from '../../../src/modules/mon/model-binding.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'

test('QQ message accepts natural text, binds owner target, and respects denial', async () => {
  const sent: unknown[] = [], approvals: string[] = []
  let denied = false
  const permissions = { async request(_ctx: unknown, capability: string) {
    approvals.push(capability); if (denied) throw new Error('denied')
  } } as unknown as PermissionService
  const mon = { async contactOwnerByQq(_session: string, input: unknown) {
    sent.push(input); return { status: 'accepted' }
  } } as unknown as MonBindingService
  const tool = contactTools(mon, permissions, 'session', 'turn').find(t => t.name === 'send_qq_message')!
  const context = { signal: new AbortController().signal, callId: 'call' }
  await tool.execute({ message: '老师，想给你看看这个。' }, context)
  assert.deepEqual(sent, [{ title: '', message: '老师，想给你看看这个。', requestId: 'turn:call' }])
  assert.deepEqual(approvals, ['contact.qq'])
  await assert.rejects(tool.execute({ message: 'hi', target: 'someone-else' }, context))
  assert.equal(approvals.length, 1)
  denied = true
  await assert.rejects(tool.execute({ message: 'hi' }, context), /denied/)
  assert.equal(sent.length, 1)
})

test('unconfigured nullable QQ bot returns a useful error rather than a schema dump', async () => {
  const client = { async get() { return { data: { bot_id: null, default_bot_id: null, default_send_target: null } } } } as unknown as MonClient
  await assert.rejects(ownerQqTarget(client, new AbortController().signal), /尚未配置 QQ 机器人/)
})
