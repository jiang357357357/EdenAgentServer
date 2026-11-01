import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityFixture, fixtureTool } from './fixture.ts'

test('QQ roles expose native QQ, email, device and App channels through their original tool implementations', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  const names = ['list_contact_channels', 'execute_qq_action', 'send_external_email', 'list_esp32_devices',
    'control_esp32_device', 'get_esp32_command_status', 'show_desktop_reminder', 'get_desktop_reminder']
  f.setChannel('qq'); f.setTools(names.map(name => ({ ...fixtureTool(), name })))
  assert.deepEqual(new Set(f.capabilities().registeredTools().map(tool => tool.name)), new Set(names))
})
