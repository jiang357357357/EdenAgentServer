import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveDesktopBroker } from '../../../src/modules/desktop/broker-server.ts'
import { DesktopBrokerClient } from '../../../src/modules/desktop/broker-client.ts'
import { desktopFixture } from './fixture.ts'

test('manual control, hardware takeover, shortcut and observer exit have distinct recorded sources', async t => {
  const f = await desktopFixture(); t.after(() => f.close())
  const a = f.account(); a.permissions.setMode('full_access')
  await a.call('desktop_list_windows', {})
  const manual = await a.service.control('pause')
  assert.equal(manual.control?.source, 'manual'); assert.match(manual.control?.message ?? '', /控制窗口暂停/)
  f.broker.arbiter.control('pause', 'physical_input')
  const physical = await a.service.status()
  assert.equal(physical.control?.source, 'physical_input'); assert.match(physical.control?.message ?? '', /本机输入/)
  f.broker.arbiter.physicalInput(true)
  assert.equal((await a.service.status()).control?.source, 'shortcut')
  f.broker.arbiter.physicalInput(true, undefined, 'observer_unavailable')
  assert.equal((await a.service.status()).control?.source, 'observer_unavailable')
  const stored = JSON.parse(readFileSync(path.join(f.root, 'control.json'), 'utf8'))
  assert.equal(stored.control.source, 'observer_unavailable'); assert.equal(stored.stopped, true)
})

test('broker restart retains control source and legacy pause does not claim to be a manual pause', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-control-state-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  writeFileSync(path.join(root, 'control.json'), JSON.stringify({ paused: true, stopped: false }))
  let broker = await serveDesktopBroker(root), client = new DesktopBrokerClient(root)
  try {
    await client.connect(false)
    assert.equal((await client.request({ type: 'status' }) as any).control.source, 'legacy')
    await client.request({ type: 'control', action: 'stop' })
    client.close(); await broker.close()
    broker = await serveDesktopBroker(root); client = new DesktopBrokerClient(root)
    await client.connect(false)
    const restored = await client.request({ type: 'status' }) as any
    assert.equal(restored.stopped, true); assert.equal(restored.control.source, 'manual')
    assert.equal(restored.control.action, 'stop'); assert.ok(restored.control.changedAt > 0)
  } finally { client.close(); await broker.close() }
})

test('invalid persisted control state starts stopped with an explicit recovery reason', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-control-invalid-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  writeFileSync(path.join(root, 'control.json'), 'not valid JSON')
  const broker = await serveDesktopBroker(root), client = new DesktopBrokerClient(root)
  try {
    await client.connect(false)
    const status = await client.request({ type: 'status' }) as any
    assert.equal(status.stopped, true); assert.equal(status.control.source, 'state_corrupt')
  } finally { client.close(); await broker.close() }
})

test('inactive legacy registration is offline rather than proof that an old broker is running', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-control-legacy-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); rmSync(root, { recursive: true, force: true }) })
  const metadata = { token: 'a'.repeat(64), protocol: 'eden.desktop.1', pid: 1 }
  writeFileSync(path.join(root, 'broker-token.json'), JSON.stringify(metadata))
  const client = new DesktopBrokerClient(root); t.after(() => client.close())
  assert.equal(await client.connect(false), false)
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'broker-token.json'), 'utf8')), metadata)
})
