import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionService } from '../src/modules/permissions/index.ts'
import type { MonBindingService } from '../src/modules/mon/model-binding.ts'
import { contactTools } from '../src/modules/mon/contact-tools.ts'

test('send_external_email requires approval and delivers only to the configured owner address', async () => {
  const permissionCalls: unknown[][] = []
  const deliveryCalls: unknown[][] = []
  const permissions = {
    async request(...args: unknown[]) { permissionCalls.push(args) },
  } as unknown as PermissionService
  const mon = {
    async contactOwnerByEmail(...args: unknown[]) {
      deliveryCalls.push(args)
      return { channel: 'email', status: 'accepted' }
    },
  } as unknown as MonBindingService
  const signal = new AbortController().signal
  const tool = contactTools(mon, permissions, 'session-1', 'turn-1')
    .find(candidate => candidate.name === 'send_external_email')!

  const result = await tool.execute(
    { title: '测试标题', message: '测试正文' },
    { callId: 'call-1', signal },
  )

  assert.deepEqual(result, { channel: 'email', status: 'accepted' })
  assert.equal(permissionCalls.length, 1)
  assert.equal(permissionCalls[0]?.[1], 'contact.email')
  assert.equal(permissionCalls[0]?.[2], 'owner-default-email')
  assert.equal(deliveryCalls.length, 1)
  assert.equal(deliveryCalls[0]?.[0], 'session-1')
  assert.deepEqual(deliveryCalls[0]?.[1], {
    title: '测试标题', message: '测试正文', requestId: 'turn-1:call-1',
  })
})

test('send_external_email rejects model-selected recipients before approval', async () => {
  let approved = false
  let delivered = false
  const permissions = {
    async request() { approved = true },
  } as unknown as PermissionService
  const mon = {
    async contactOwnerByEmail() { delivered = true; return {} },
  } as unknown as MonBindingService
  const tool = contactTools(mon, permissions, 'session-1', 'turn-1')
    .find(candidate => candidate.name === 'send_external_email')!

  await assert.rejects(
    tool.execute(
      { title: '测试标题', message: '测试正文', to: 'attacker@example.com' },
      { callId: 'call-1', signal: new AbortController().signal },
    ),
    /unrecognized key/i,
  )
  assert.equal(approved, false)
  assert.equal(delivered, false)
})
