import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { MarketService, MarketRepository, PackagePreviewRepository, InstalledPackageRepository } from '../src/modules/plugin-market/index.ts'
import { ConnectorCatalog, ConnectorRepository, ConnectorPermissions, ConnectorCredentials, ConnectorEventRepository } from '../src/modules/connectors/index.ts'
import { SessionRepository } from '../src/modules/sessions/index.ts'
import { JobRepository } from '../src/modules/jobs/index.ts'
import type { ConnectorManifest } from '@eden/api'

export const fixtureSource = `import {runConnector} from '@eden/plugin-sdk/connector';
import {readFile} from 'node:fs/promises';
await runConnector({id:'arbitrary-weather',version:'1.0.0',events:['changed'],queries:['echo','read'],actions:['publish'],
initialize(context){return {health:()=>({state:'ready',initialized:true}),
query:async call=>call.capability==='read'?{text:await readFile(context.settings.file,'utf8')}:{value:call.payload},
execute(call){context.publish('changed',call.operationId,call.payload);return {published:true}},close(){}}}});`
export function fixtureManifest(permissions: ConnectorManifest['permissions'] = []) {
  return { id: 'arbitrary-weather', name: 'Weather', description: 'Arbitrary user-created connector', icon: 'cable', version: '1.0.0', runtime: 'node',
    entrypoints: { node: { path: 'worker.mjs', args: [] } }, permissions,
    settingsSchema: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false }, events: { changed: {} }, queries: { echo: {}, read: {} }, actions: { publish: {} } }
}
export async function connectorFixture(t: TestContext, permissions: ConnectorManifest['permissions'] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-generic-connector-'))
  const dataRoot = path.join(root, 'private', 'realms', 'local', 'v2'), packageRoot = path.join(root, 'package')
  await mkdir(dataRoot, { recursive: true }); await mkdir(packageRoot)
  const database = new EdenDatabase(':memory:', 'local'), marketRepository = new MarketRepository(database)
  const market = new MarketService(marketRepository, new PackagePreviewRepository(database, marketRepository), new InstalledPackageRepository(database, marketRepository))
  const catalog = new ConnectorCatalog(); catalog.attachComponentProvider(() => market.installed.connectorSelectionPlans())
  const connectors = new ConnectorRepository(database, catalog), grants = new ConnectorPermissions(database, catalog, connectors)
  const credentials = new ConnectorCredentials(database, connectors, catalog)
  const events = new ConnectorEventRepository(new SessionRepository(database, 'local'), connectors, catalog, new JobRepository(database))
  const cleanup: (() => Promise<unknown>)[] = []
  t.after(async () => { for (const close of cleanup) await close(); await market.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const bundled = await build({ stdin: { contents: fixtureSource, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false })
  await writeFile(path.join(packageRoot, 'worker.mjs'), bundled.outputFiles[0]!.contents)
  await writeFile(path.join(packageRoot, 'connector.json'), JSON.stringify(fixtureManifest(permissions)))
  await writeFile(path.join(packageRoot, 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'custom.weather', name: 'Weather', description: 'Fixture', version: '1.0.0',
    components: { runtimes: [{ id: 'weather', kind: 'connector', manifest: 'connector.json' }] }, permissions }))
  const preview = await market.inspectLocal(packageRoot)
  market.installed.install(market.previews.read(preview.previewID), true, false)
  const enable = () => {
    market.installed.setPermissions(preview.id, preview.revision, permissions.map(item => ({ capability: item.capability, resource: item.resource, access: item.access, decision: 'allowed' as const })))
    market.installed.enable(preview.id)
    return market.installed.connectorSelectionPlans()[0]!.plans[0]!.key
  }
  return { cleanup, root, dataRoot, packageRoot, database, market, catalog, connectors, grants, credentials, events, preview, enable, readFile }
}
