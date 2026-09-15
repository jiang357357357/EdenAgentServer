import assert from 'node:assert/strict'
import test from 'node:test'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/model-binding.ts'
import { deviceTools } from '../../../src/modules/mon/device-tools.ts'

test('every ESP32 tool exposes an object-root parameter schema', () => {
  const permissions = {} as PermissionService
  const mon = {} as MonBindingService
  for (const tool of deviceTools(mon, permissions, 'session-1', 'turn-1')) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} must expose an object-root schema`)
  }
})

test('ESP32 SMS requires approval and creates a deterministic owner command', async () => {
  const approvals: unknown[][] = []
  const commands: unknown[][] = []
  const permissions = { async request(...args: unknown[]) { approvals.push(args) } } as unknown as PermissionService
  const mon = { async issueEsp32Command(...args: unknown[]) { commands.push(args); return { status: 'accepted' } } } as unknown as MonBindingService
  const tool = deviceTools(mon, permissions, 'session-1', 'turn-1').find(item => item.name === 'control_esp32_device')!
  const result = await tool.execute(
    { deviceId: 7, action: 'message.send', text: '请休息' },
    { callId: 'call-1', signal: new AbortController().signal },
  )
  assert.deepEqual(result, { status: 'accepted' })
  assert.equal(approvals[0]?.[1], 'device.control')
  assert.equal(approvals[0]?.[2], 'esp32:7:message.send')
  assert.deepEqual(commands[0]?.[1], {
    device_id: 7,
    action: 'message.send',
    arguments: { text: '请休息' },
    request_id: 'turn-1:call-1',
    ttl_seconds: 10,
  })
})

test('ESP32 notification uses a bounded temporary dialog payload', async () => {
  const commands: unknown[][] = []
  const permissions = { async request() {} } as unknown as PermissionService
  const mon = { async issueEsp32Command(...args: unknown[]) { commands.push(args); return { status: 'accepted' } } } as unknown as MonBindingService
  const tool = deviceTools(mon, permissions, 'session-1', 'turn-3').find(item => item.name === 'control_esp32_device')!
  await tool.execute(
    { deviceId: 7, action: 'notification.show', title: '提醒', text: '该喝水了', durationMs: 8000 },
    { callId: 'call-3', signal: new AbortController().signal },
  )
  assert.deepEqual(commands[0]?.[1], {
    device_id: 7,
    action: 'notification.show',
    arguments: { title: '提醒', text: '该喝水了', duration_ms: 8000 },
    request_id: 'turn-3:call-3',
    ttl_seconds: 10,
  })
})

test('ESP32 control rejects arbitrary actions before approval', async () => {
  let approved = false
  let issued = false
  const permissions = { async request() { approved = true } } as unknown as PermissionService
  const mon = { async issueEsp32Command() { issued = true; return {} } } as unknown as MonBindingService
  const tool = deviceTools(mon, permissions, 'session-1', 'turn-1').find(item => item.name === 'control_esp32_device')!
  await assert.rejects(
    tool.execute({ deviceId: 7, action: 'system.flash_firmware', url: 'https://example.invalid/a.bin' }, { callId: 'call-1', signal: new AbortController().signal }),
  )
  assert.equal(approved, false)
  assert.equal(issued, false)
})

test('ESP32 call starts a bounded incoming-call invitation', async () => {
  const commands: unknown[][] = []
  const permissions = { async request() {} } as unknown as PermissionService
  const mon = { async issueEsp32Command(...args: unknown[]) { commands.push(args); return { status: 'accepted' } } } as unknown as MonBindingService
  const tool = deviceTools(mon, permissions, 'session-1', 'turn-2').find(item => item.name === 'control_esp32_device')!

  await tool.execute(
    {
      deviceId: 7,
      action: 'call.start',
      reason: '阿罗娜的来电',
      suggestedOpening: '老师，阿罗娜来确认电话是否正常接通。',
      currentSituation: '老师正在测试 ESP 主动来电功能。',
    },
    { callId: 'call-2', signal: new AbortController().signal },
  )

  assert.deepEqual(commands[0]?.[1], {
    device_id: 7,
    action: 'call.start',
    arguments: {
      reason: '阿罗娜的来电',
      current_situation: '老师正在测试 ESP 主动来电功能。',
      suggested_opening: '老师，阿罗娜来确认电话是否正常接通。',
    },
    request_id: 'turn-2:call-2',
    ttl_seconds: 30,
  })
})
