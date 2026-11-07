import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { uiPluginTools } from '../../../src/modules/plugin-ui/tools.ts'
import { pluginMarketRoutes } from '../../../src/transport/rpc/plugin-market.routes.ts'
import { writeTodoPackage, todoPluginId, todoCall, todoValue, waitUntil } from './fullstack-fixture.ts'

async function fixture(t: TestContext, options: { optional?: boolean; disabled?: boolean; broken?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-plugin-activation-'))
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
  const runtime = await openRuntime(loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'host') }, root))
  t.after(async () => { try { await runtime.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const { services } = runtime
  services.permissions.setMode('full_access')
  const session = services.repository.create('组合插件启用验收', [], null)
  const directory = path.join(root, 'package')
  await writeTodoPackage(directory, path.join(root, 'business'))
  const manifestPath = path.join(directory, 'plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.permissions[0].required = !options.optional
  manifest.permissions.push({ capability: 'network.connect', resource: 'https://optional.invalid', access: 'connect', required: false, description: '未使用的可选网络能力' })
  manifest.components.runtimes[0].enabledByDefault = !options.disabled
  await writeFile(manifestPath, JSON.stringify(manifest))
  if (options.broken) await writeFile(path.join(directory, 'backend.mjs'), `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);if(req.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32603,message:'EXPECTED_BACKEND_INITIALIZATION_FAILURE'}})+'\\n');
});`)
  const tool = uiPluginTools(services.pluginMarket, services.permissions, session.id, randomUUID(), undefined, () => [], services.mcp)[0]!
  const call = (action: string, args: Record<string, unknown> = {}) => tool.execute({ action, id: todoPluginId, ...args }, { callId: randomUUID(), signal: new AbortController().signal })
  await call('inspect', { path: directory })
  return { root, runtime, services, session, directory, call, manifestPath,
    routes: runtime.routes as ReturnType<typeof pluginMarketRoutes> }
}
type Installed = { enabled: boolean; error?: string; backend?: { state: string; errors?: { error: string }[] } }

for (const mode of ['full_access', 'takeover'] as const) {
  test(`${mode} installs, authorizes and starts the real backend without a manual grant`, { timeout: 40_000 }, async t => {
    const f = await fixture(t)
    f.services.permissions.setMode(mode)
    const result = await f.call('install') as Installed
    assert.equal(result.enabled, true)
    assert.equal(result.backend?.state, 'ready')
    const grants = f.services.pluginMarket.installed.read(todoPluginId).permissionGrants
    assert.equal(grants.length, 1)
    assert.equal(grants[0]!.resource, 'node')
    assert.equal(grants[0]!.decision, 'allowed')
    assert.equal(f.services.permissions.list(f.session.id).some(item => item.state === 'pending'), false)
    const created = todoValue(await todoCall(f.runtime, f.session.id, 'add', { title: '自动授权后真实持久化' }))
    assert.equal(created.todos[0]!.title, '自动授权后真实持久化')
    assert.equal(todoValue(await todoCall(f.runtime, f.session.id, 'list')).todos.length, 1)
  })
}

test('enabled backends receive their actual optional grant; install-only stays disabled and ungranted', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { optional: true })
  await f.call('install', { enabled: false })
  let current = f.services.pluginMarket.installed.read(todoPluginId)
  assert.equal(current.enabled, false)
  assert.deepEqual(current.permissionGrants, [])
  assert.equal(f.services.mcp.list().runtimes.length, 0)
  assert.equal((await f.call('enable') as Installed).backend?.state, 'ready')
  current = f.services.pluginMarket.installed.read(todoPluginId)
  assert.equal(current.permissionGrants.length, 1)
  assert.equal(current.permissionGrants[0]!.resource, 'node')
})

test('an immediately mounted UI waits for its enabled backend instead of failing before the first lifecycle tick', { timeout: 40_000 }, async t => {
  const f = await fixture(t)
  await f.call('install', { enabled: false })
  await f.routes['plugin.enable']!({ id: todoPluginId, enabled: true })
  assert.equal(f.services.mcp.list().runtimes.length, 0)
  const value = todoValue(await todoCall(f.runtime, f.session.id, 'list'))
  assert.deepEqual(value.todos, [])
  assert.equal(f.services.mcp.list().runtimes.length, 1)
})

test('disabled optional runtimes stay closed until explicitly selected, then activate in one operation', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { optional: true, disabled: true })
  assert.equal((await f.call('install') as Installed).backend?.state, 'disabled')
  assert.deepEqual(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants, [])
  const result = await f.call('enable', { enableComponents: ['backend'] }) as Installed
  assert.equal(result.backend?.state, 'ready')
  assert.equal(f.services.pluginMarket.installed.read(todoPluginId).components.find(item => item.id === 'backend')!.enabled, true)
})

test('restricted activation awaits approval; refusal leaves components, grants and the backend unchanged', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { optional: true, disabled: true })
  await f.call('install', { enabled: false })
  f.services.permissions.setMode('restricted')
  const enabling = f.call('enable', { enableComponents: ['backend'] })
  const rejected = assert.rejects(enabling, /denied|拒绝/i)
  await waitUntil(() => f.services.permissions.list(f.session.id).some(item => item.state === 'pending'))
  const request = f.services.permissions.list(f.session.id).find(item => item.state === 'pending')!
  assert.equal(request.capability, 'plugin.package.activate')
  assert.match(JSON.stringify(request.details), /process.execute/)
  assert.deepEqual(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants, [])
  f.services.permissions.resolve(request.id, false)
  await rejected
  const current = f.services.pluginMarket.installed.read(todoPluginId)
  assert.equal(current.enabled, false)
  assert.equal(current.components.find(item => item.id === 'backend')!.enabled, false)
  assert.deepEqual(current.permissionGrants, [])
  assert.equal(f.services.mcp.list().runtimes.length, 0)
})

test('a changed component during approval invalidates the whole activation plan', { timeout: 40_000 }, async t => {
  const f = await fixture(t)
  await f.call('install', { enabled: false })
  f.services.permissions.setMode('restricted')
  const enabling = f.call('enable')
  const rejected = assert.rejects(enabling, /审批期间发生变化/)
  await waitUntil(() => f.services.permissions.list(f.session.id).some(item => item.state === 'pending'))
  const current = f.services.pluginMarket.installed.read(todoPluginId)
  f.services.pluginMarket.installed.setComponent(todoPluginId, current.revision, 'backend', false)
  f.services.permissions.resolve(f.services.permissions.list(f.session.id).find(item => item.state === 'pending')!.id, true)
  await rejected
  assert.deepEqual(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants, [])
})

test('desktop enable and component selection use the same full-access activation plan', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { optional: true, disabled: true })
  await f.call('install', { enabled: false })
  const routes = f.routes
  await routes['plugin.enable']!({ id: todoPluginId, enabled: true })
  assert.deepEqual(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants, [])
  const revision = f.services.pluginMarket.installed.read(todoPluginId).revision
  const marketRoutes = pluginMarketRoutes(f.services.pluginMarket, f.services.permissions)
  await marketRoutes['plugin.component.set']!({ id: todoPluginId, revision, componentId: 'backend', enabled: true })
  assert.equal((await f.services.mcp.waitForPackage(todoPluginId, new AbortController().signal)).state, 'ready')
  assert.equal(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants.length, 1)
})

test('initialization failures are reported as backend failures with their original reason', { timeout: 40_000 }, async t => {
  const f = await fixture(t, { broken: true })
  const result = await f.call('install') as Installed
  assert.equal(result.enabled, true)
  assert.equal(result.backend?.state, 'failed')
  assert.match(JSON.stringify(result.backend?.errors), /EXPECTED_BACKEND_INITIALIZATION_FAILURE/)
  assert.equal(f.services.mcp.list().runtimes.length, 0)
})

test('activation failure rolls back newly granted permissions instead of leaving a partially authorized package', { timeout: 40_000 }, async t => {
  const f = await fixture(t)
  await f.call('install')
  const directory = path.join(f.root, 'conflicting-package')
  await writeTodoPackage(directory, path.join(f.root, 'other-business'))
  const manifest = JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8'))
  manifest.id = 'conflicting-todos'
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest))
  await f.call('inspect', { id: manifest.id, path: directory })
  const result = await f.call('install', { id: manifest.id }) as Installed
  assert.equal(result.enabled, false)
  assert.match(result.error!, /重名/)
  assert.deepEqual(f.services.pluginMarket.installed.read(manifest.id).permissionGrants, [])
  assert.equal(f.services.pluginMarket.installed.read(todoPluginId).enabled, true)
})

test('desktop restricted mode preserves explicit grants and readiness does not report a stalled backend as ready', { timeout: 40_000 }, async t => {
  const f = await fixture(t)
  await f.call('install', { enabled: false })
  f.services.permissions.setMode('restricted')
  await assert.rejects(async () => f.routes['plugin.enable']!({ id: todoPluginId, enabled: true }), /permission/i)
  assert.deepEqual(f.services.pluginMarket.installed.read(todoPluginId).permissionGrants, [])
  await writeFile(path.join(f.directory, 'backend.mjs'), 'process.stdin.resume()')
  f.services.permissions.setMode('full_access')
  await f.call('inspect', { path: f.directory })
  await f.call('install', { enabled: false })
  await f.routes['plugin.enable']!({ id: todoPluginId, enabled: true })
  const state = await f.services.mcp.waitForPackage(todoPluginId, new AbortController().signal, 100)
  assert.equal(state.state, 'starting')
  assert.equal(f.services.mcp.list().runtimes.length, 0)
})
