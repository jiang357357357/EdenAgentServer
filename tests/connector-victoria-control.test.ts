import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ConnectorContext } from '@eden/plugin-sdk/connector'
import type { JsonValue } from '@eden/api'
import { probeControl } from '../connectors/official/victoria3/src/control-probe.ts'

test('Victoria control requires separate desktop approval and cleans files after matching ACK', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-victoria-probe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context: ConnectorContext = { protocolVersion: 1, connectorInstanceId: '00000000-0000-4000-8000-000000000001', connectorKey: 'victoria3', packageVersion: '2.0.0',
    settings: { controlEnabled: true, commandDirectory: root }, dataDirectory: root, signal: new AbortController().signal, publish() {}, status() {},
    grantedPermissions: [{ capability: 'filesystem.write', resource: root, access: 'write' }] }
  const state: Record<string, JsonValue> = { attached: true, bridgeSeen: true, latestAck: null }
  let injected = false
  await assert.rejects(probeControl(context, state, async () => { injected = true }), /not approved/)
  assert.equal(injected, false); assert.deepEqual(await readdir(root), [])
  context.grantedPermissions.push({ capability: 'desktop.input', resource: 'application:victoria3', access: 'control' })
  const result = await probeControl(context, state, async input => {
    const command = await readFile(path.join(root, input.stem + '.txt'), 'utf8')
    const id = /command_id=([a-f0-9-]+)/.exec(command)?.[1]
    assert.ok(id); assert.ok(!command.includes('add_building'))
    state.latestAck = { commandId: id, status: 'success' }
  }) as { acknowledged: boolean }
  assert.equal(result.acknowledged, true); assert.deepEqual(await readdir(root), [])
})

test('failed Victoria console injection never reports success and removes generated commands', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-victoria-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const context: ConnectorContext = { protocolVersion: 1, connectorInstanceId: '00000000-0000-4000-8000-000000000001', connectorKey: 'victoria3', packageVersion: '2.0.0',
    settings: { controlEnabled: true, commandDirectory: root }, dataDirectory: root, signal: new AbortController().signal, publish() {}, status() {},
    grantedPermissions: [{ capability: 'filesystem.write', resource: root, access: 'write' }, { capability: 'desktop.input', resource: 'application:victoria3', access: 'control' }] }
  await assert.rejects(probeControl(context, { attached: true, bridgeSeen: true }, async () => { throw new Error('focus lost') }), /focus lost/)
  assert.deepEqual(await readdir(root), [])
})
