import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connectorFixture, fixtureManifest } from '../../connector-fixture.ts'
import { connectorPluginTools } from '../../../src/modules/plugin-market/connector-tools.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { launchComponent } from '../../../src/modules/connectors/launch-component.ts'

// Exercises the tools available to a model with newly authored source, not a recorded model or a bundled connector.
test('authored connector builds outside the repository, installs through approved tools and runs a real worker', { timeout: 30000 }, async t => {
  const f = await connectorFixture(t)
  const sessions = new SessionRepository(f.database, 'local')
  const session = sessions.create('Connector authoring acceptance')
  const permissions = new PermissionService(f.database, sessions.events)
  const tool = connectorPluginTools(f.market, permissions, session.id, session.id)[0]!
  let sequence = 0
  const call = (action: string, args: Record<string, unknown> = {}) => tool.execute({ action, args }, {
    callId: `author-${++sequence}`, signal: new AbortController().signal,
  })
  const unsubscribe = sessions.events.subscribe(event => {
    if (event.kind === 'permission.requested') queueMicrotask(() => {
      for (const request of permissions.list(session.id).filter(item => item.state === 'pending')) permissions.resolve(request.id, true)
    })
  })
  t.after(unsubscribe)
  const guide = await call('describe') as { build: string }
  assert.match(guide.build, /--source/)
  const source = path.join(f.root, 'new-connector'), output = path.join(f.root, 'built')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await mkdir(path.join(source, 'package'))
  const manifest = { ...fixtureManifest(), id: 'local-notes', entrypoints: { node: { path: 'worker/main.mjs', args: [] } },
    queries: { read: {} }, actions: { write: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }
  await writeFile(path.join(source, 'package/connector.json'), JSON.stringify(manifest))
  await writeFile(path.join(source, 'package/plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'authored.notes', name: 'Local notes', description: 'New connector acceptance', version: '1.0.0', permissions: [], components: { runtimes: [{ id: 'notes', kind: 'connector', manifest: 'connector.json' }] } }))
  await writeFile(path.join(source, 'src/main.ts'), `import {runConnector} from '@eden/plugin-sdk/connector';
import {readFile,writeFile} from 'node:fs/promises'; import path from 'node:path';
await runConnector({id:'local-notes',version:'1.0.0',events:['changed'],queries:['read'],actions:['write'],
initialize(context){const file=path.join(context.dataDirectory,'note.txt');return {
health:()=>({state:'ready',initialized:true}),
query:async()=>({text:await readFile(file,'utf8')}),
execute:async call=>{await writeFile(file,call.payload.text);context.publish('changed',call.operationId,{text:call.payload.text});return {saved:true}},close(){}}}});`)
  await promisify(execFile)(process.execPath, ['Script/Project/package_connector.mjs', '--source', source, output], { cwd: process.cwd() })
  assert.ok(JSON.parse(await readFile(path.join(output, 'checksums.json'), 'utf8'))['worker/main.mjs'])
  const preview = await call('inspect', { path: output }) as { previewID: string; id: string }
  await call('install', { previewID: preview.previewID })
  await call('enable', { id: preview.id })
  assert.ok(JSON.stringify(await call('list')).includes('authored.notes'))
  const key = f.catalog.list().connectors.find(item => item.name === manifest.name)!.key
  const instance = f.connectors.create({ connectorKey: key, identityKey: 'acceptance', displayName: 'Local notes', settings: {}, desiredState: 'connected' })
  const abort = new AbortController()
  const launched = await launchComponent(instance.id, f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials, abort.signal)
  f.cleanup.push(() => launched.runtime.close())
  assert.deepEqual(await launched.runtime.invoke('execute', 'write', { text: '真实连接器记事' }, 'write-note', abort.signal), { saved: true })
  assert.deepEqual(await launched.runtime.invoke('query', 'read', {}, 'read-note', abort.signal), { text: '真实连接器记事' })
  for (let i = 0; i < 20 && !f.database.connection.prepare('SELECT 1 FROM connector_events WHERE connector_id=?').get(instance.id); i++) await delay(25)
  assert.ok(f.database.connection.prepare('SELECT 1 FROM connector_events WHERE connector_id=?').get(instance.id))
  await call('disable', { id: preview.id })
  await assert.rejects(launched.runtime.invoke('query', 'read', {}, 'disabled', abort.signal), /authorization|permission|component/i)
  assert.ok(permissions.list(session.id).every(item => item.state === 'allowed'))
})
