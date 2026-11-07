import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pluginUiDocumentSchema, toJson, type PluginUiCall } from '@eden/api'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { uiPluginTools } from '../../../src/modules/plugin-ui/index.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-extension-platform-'))
  const source = path.join(root, 'source'), workspace = path.join(root, 'workspace')
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../../Script/Project/create_extension.mjs', import.meta.url)), source, 'platform-test'])
  await mkdir(workspace); await writeFile(path.join(workspace, 'note.txt'), 'original')
  const document = JSON.parse(await readFile(path.join(source, 'ui.json'), 'utf8'))
  document.capabilities.documents = true
  await writeFile(path.join(source, 'ui.json'), JSON.stringify(document))
  const config = loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'data') }, root)
  let runtime = await openRuntime(config)
  t.after(async () => { await runtime.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) })
  const session = runtime.services.repository.create('扩展平台验收', [], null)
  runtime.services.workspace.forSession(session.id).switch(workspace)
  runtime.services.permissions.setMode('full_access')
  const preview = await runtime.services.pluginMarket.inspectLocal(source)
  runtime.services.pluginMarket.installed.install(runtime.services.pluginMarket.previews.read(preview.previewID), true, false)
  runtime.services.pluginMarket.installed.enable('platform-test')
  const module = runtime.services.pluginUi.list().modules[0]!
  const call = (action: PluginUiCall['action'], input: Record<string, unknown>) => {
    return runtime.services.pluginUi.call({ ...module, viewId: '$extension', sessionId: session.id, requestId: randomUUID(), action,
      input: toJson(input) as PluginUiCall['input'] })
  }
  return { root, source, workspace, session, call, get runtime() { return runtime }, async restart() {
    await runtime.close(); runtime = await openRuntime(config); runtime.services.permissions.setMode('full_access')
  } }
}
const state = { namespace: 'storage', scope: 'global', key: 'count' }

test('new presentation declarations survive inspection and installation with the original session ownership checks',async t=>{
  const f=await fixture(t),document=JSON.parse(await readFile(path.join(f.source,'ui.json'),'utf8'))
  for(const slot of ['full_page','sidebar_panel','bottom_panel','floating_window'])document.views.push({id:slot,title:slot,slot,renderer:'webview',entry:'view.html'})
  await writeFile(path.join(f.source,'ui.json'),JSON.stringify(document))
  const market=f.runtime.services.pluginMarket,preview=await market.inspectLocal(f.source)
  market.installed.install(market.previews.read(preview.previewID),true,false);market.installed.enable('platform-test')
  const module=f.runtime.services.pluginUi.list().modules[0]!
  for(const slot of ['full_page','sidebar_panel','bottom_panel','floating_window']){
    assert.equal(module.document.views.find(view=>view.id===slot)!.slot,slot)
    const call={pluginId:module.pluginId,componentId:module.componentId,revision:module.revision,viewId:slot,sessionId:f.session.id,requestId:randomUUID(),action:'extension.state' as const,input:{...state,key:slot,value:slot}}
    assert.equal((await f.runtime.services.pluginUi.call(call) as {value:string}).value,slot)
    await assert.rejects(async()=>withAccount({key:'another',userId:'another',coreBaseUrl:'https://fixture.invalid'},()=>f.runtime.services.pluginUi.call({...call,requestId:randomUUID()})))
  }
})

test('API 2 authoring validates contributions, resource integrity and old API compatibility', async t => {
  const f = await fixture(t), module = f.runtime.services.pluginUi.list().modules[0]!
  assert.equal(module.document.apiVersion, 2)
  assert.ok(module.assets?.['view.html']?.sha256)
  assert.equal('resources' in module, false)
  assert.match(f.runtime.services.pluginUi.read(module).resources!['view.html']!, /acquireEdenApi/)
  const raw = JSON.parse(await readFile(path.join(f.source, 'ui.json'), 'utf8'))
  const invalid = structuredClone(raw); invalid.contributes.menus.push({ command: 'missing', location: 'toolbar' })
  assert.equal(pluginUiDocumentSchema.safeParse(invalid).success, false)
  const invalidSetting = structuredClone(raw); invalidSetting.contributes.configuration.greeting.default = 1
  assert.equal(pluginUiDocumentSchema.safeParse(invalidSetting).success, false)
  const old = { schemaVersion: 1, type: 'module', apiVersion: 1, entry: 'client.js', views: [{ id: 'main', slot: 'page', title: '旧版' }] }
  assert.equal(pluginUiDocumentSchema.parse(old).apiVersion, 1)
})

test('UI package inspection resolves relative paths from the selected session workspace', async t => {
  const f = await fixture(t), directory = path.join(f.workspace, 'package')
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../../Script/Project/create_extension.mjs', import.meta.url)), directory, 'relative-package-test'])
  const services = f.runtime.services
  const tool = uiPluginTools(services.pluginMarket, services.permissions, f.session.id, randomUUID(), undefined, undefined, services.mcp, undefined,
    () => services.workspace.forSession(f.session.id).availableRoot())[0]!
  const result = await tool.execute({ action: 'inspect', path: 'package' }, { callId: randomUUID(), signal: new AbortController().signal }) as { id: string }
  assert.equal(result.id, 'relative-package-test')
})

test('storage survives host restart and rejects conflicting, cross-account and cross-workspace writes', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.call('extension.state', state), { value: null, revision: 0 })
  assert.deepEqual(await f.call('extension.state', { ...state, value: 1, expectedRevision: 0 }), { value: 1, revision: 1 })
  await assert.rejects(f.call('extension.state', { ...state, value: 2, expectedRevision: 0 }), /changed/)
  await f.restart()
  assert.deepEqual(await f.call('extension.state', state), { value: 1, revision: 1 })
  const workspaceState = { ...state, scope: 'workspace' }
  await f.call('extension.state', { ...workspaceState, value: 11 })
  const other = path.join(f.root, 'other'); await mkdir(other)
  f.runtime.services.workspace.forSession(f.session.id).switch(other)
  assert.deepEqual(await f.call('extension.state', workspaceState), { value: null, revision: 0 })
  f.runtime.services.workspace.forSession(f.session.id).switch(f.workspace)
  assert.deepEqual(await f.call('extension.state', workspaceState), { value: 11, revision: 1 })
  await assert.rejects(async () => withAccount({ key: 'another', userId: 'another', coreBaseUrl: 'https://fixture.invalid' }, () => f.call('extension.state', state)))
})

test('declared settings preserve types, defaults, deletion revisions and component revocation', async t => {
  const f = await fixture(t), setting = { ...state, namespace: 'configuration', key: 'greeting' }
  const before = f.runtime.services.pluginUi.list().modules[0]!.configurationRevision
  assert.deepEqual(await f.call('extension.state', setting), { value: '你好，老师', revision: 0 })
  await assert.rejects(f.call('extension.state', { ...setting, value: false }), /Invalid setting/)
  await assert.rejects(f.call('extension.state', { ...setting, key: 'undeclared' }), /Undeclared/)
  await f.call('extension.state', { ...setting, value: '新问候', expectedRevision: 0 })
  assert.equal(f.runtime.services.pluginUi.list().modules[0]!.configurationRevision, before! + 1)
  assert.deepEqual(await f.call('extension.state', { ...setting, remove: true, expectedRevision: 1 }), { value: '你好，老师', revision: 2 })
  const module = f.runtime.services.pluginUi.list().modules[0]!
  f.runtime.services.pluginMarket.installed.setComponent(module.pluginId, module.revision, module.componentId, false)
  await assert.rejects(async () => f.call('extension.state', state))
})

test('custom editor reads real files and refuses stale revisions, outside paths and undeclared document access', async t => {
  const f = await fixture(t), input = { path: 'note.txt' }
  const initial = await f.call('document.read', input) as { content: string; revision: string }
  assert.equal(initial.content, 'original')
  await f.call('document.save', { ...input, content: 'saved', revision: initial.revision })
  assert.equal(await readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'saved')
  await assert.rejects(f.call('document.save', { ...input, content: 'overwrite', revision: initial.revision }))
  assert.equal(await readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'saved')
  await writeFile(path.join(f.root, 'outside.txt'), 'outside')
  await assert.rejects(f.call('document.read', { path: '../outside.txt' }))
  const document = JSON.parse(await readFile(path.join(f.source, 'ui.json'), 'utf8'))
  document.capabilities.documents = false
  await writeFile(path.join(f.source, 'ui.json'), JSON.stringify(document))
  const market = f.runtime.services.pluginMarket, preview = await market.inspectLocal(f.source)
  market.installed.install(market.previews.read(preview.previewID), true, false); market.installed.enable('platform-test')
  const current = f.runtime.services.pluginUi.list().modules[0]!
  await assert.rejects(async () => f.runtime.services.pluginUi.call({ ...current, viewId: '$extension', sessionId: f.session.id,
    requestId: randomUUID(), action: 'document.read', input: { path: 'note.txt' } }), /does not declare document/)
})

test('changing workspace during state approval rejects the original write instead of moving it', async t => {
  const f = await fixture(t)
  f.runtime.services.permissions.setMode('restricted')
  const requested = new Promise<string>(resolve => {
    const stop = f.runtime.services.repository.events.subscribe(event => {
      if (event.kind === 'permission.requested') { stop(); resolve(String((event.payload as { id: string }).id)) }
    })
  })
  const write = f.call('extension.state', { ...state, scope: 'workspace', value: 'original workspace' })
  const rejected = assert.rejects(write, /Workspace changed/)
  const permissionId = await requested, other = path.join(f.root, 'changed-during-approval')
  await mkdir(other); f.runtime.services.workspace.forSession(f.session.id).switch(other)
  f.runtime.services.permissions.resolve(permissionId, true)
  await rejected
  f.runtime.services.permissions.setMode('full_access')
  assert.deepEqual(await f.call('extension.state', { ...state, scope: 'workspace' }), { value: null, revision: 0 })
})
