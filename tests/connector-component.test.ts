import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { connectorFixture } from './connector-fixture.ts'
import { launchComponent } from '../src/modules/connectors/launch-component.ts'

test('arbitrary TS connector uses installed package selection, framed queries and persisted events', async t => {
  const f = await connectorFixture(t)
  assert.deepEqual(f.market.installed.connectorSelectionPlans(), [])
  const key = f.enable()
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'weather-local', displayName: 'Weather', settings: {}, desiredState: 'connected' })
  assert.equal(f.grants.read(instance.id).ready, true)
  const abort = new AbortController()
  const launched = await launchComponent(instance.id, f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials, abort.signal)
  try {
    assert.deepEqual(await launched.runtime.invoke('query', 'echo', { message: '中文' }, 'query-1', abort.signal), { value: { message: '中文' } })
    assert.deepEqual(await launched.runtime.invoke('execute', 'publish', { rain: true }, 'event-1', abort.signal), { published: true })
    const row = f.database.connection.prepare('SELECT payload_json FROM connector_events WHERE connector_id=?').get(instance.id)
    assert.deepEqual(JSON.parse(String(row?.payload_json)), { rain: true })
    f.market.installed.disable(f.preview.id)
    await assert.rejects(launched.runtime.invoke('query', 'echo', {}, 'stale', abort.signal), /authorization|permission|component/i)
  } finally { await launched.runtime.close() }
})

test('connector path access requires package and instance grants; immutable snapshot survives source replacement', async t => {
  const declaration = { capability: 'filesystem.read', resource: 'settings.file', access: 'read', required: true, description: 'Read selected fixture' }
  const f = await connectorFixture(t, [declaration])
  assert.throws(() => f.market.installed.enable(f.preview.id), /permissions/)
  const key = f.enable(), file = path.join(f.root, 'input.txt')
  await writeFile(file, 'only approved content')
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'reader', displayName: 'Reader', settings: { file }, desiredState: 'connected' })
  assert.equal(f.grants.read(instance.id).ready, false)
  const requested = f.grants.read(instance.id)
  f.grants.set({ id: instance.id, generation: instance.generation, revision: requested.revision, decisions: requested.permissions.map(permission => ({ key: permission.key, allowed: true })) })
  await writeFile(path.join(f.packageRoot, 'worker.mjs'), 'throw new Error("replaced after install")')
  const abort = new AbortController(), launched = await launchComponent(instance.id, f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials, abort.signal)
  try {
    assert.deepEqual(await launched.runtime.invoke('query', 'read', {}, 'read-1', abort.signal), { text: 'only approved content' })
    f.grants.clear({ id: instance.id, generation: instance.generation })
    await assert.rejects(launched.runtime.invoke('query', 'read', {}, 'read-2', abort.signal), /authorization|permission|generation/i)
  } finally { await launched.runtime.close() }
})

test('selecting changed package bytes disables connector and invalidates the prior resource revision', async t => {
  const f = await connectorFixture(t), key = f.enable()
  const old = f.catalog.descriptor(key).revision
  await writeFile(path.join(f.packageRoot, 'additional.txt'), 'new revision')
  const preview = await f.market.inspectLocal(f.packageRoot)
  assert.notEqual(preview.revision, f.preview.revision)
  f.market.installed.install(f.market.previews.read(preview.previewID), true, false)
  assert.throws(() => f.catalog.descriptor(key), /unavailable/)
  f.market.installed.enable(preview.id)
  assert.notEqual(f.catalog.descriptor(key).revision, old)
})

test('optional instance permissions cannot exceed the selected plugin version grants', async t => {
  const permission = { capability: 'filesystem.read', resource: 'settings.file', access: 'read', required: false, description: 'Optional file' }
  const f = await connectorFixture(t, [permission])
  f.market.installed.enable(f.preview.id)
  const key = f.market.installed.connectorSelectionPlans()[0]!.plans[0]!.key
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'optional', displayName: 'Optional reader', settings: { file: '/unapproved' }, desiredState: 'disconnected' })
  const snapshot = f.grants.read(instance.id)
  assert.equal(snapshot.permissions[0]?.packageAllowed, false)
  assert.throws(() => f.grants.set({ id: instance.id, generation: instance.generation, revision: snapshot.revision,
    decisions: [{ key: snapshot.permissions[0]!.key, allowed: true }] }), /Permission/)
})
