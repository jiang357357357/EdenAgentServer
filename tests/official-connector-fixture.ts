import type { TestContext } from 'node:test'
import path from 'node:path'
import { connectorFixture } from './connector-fixture.ts'
import { launchComponent } from '../src/modules/connectors/launch-component.ts'

export async function officialConnectorFixture(t: TestContext, key: string, settings: Record<string, unknown>, secret?: string) {
  const f = await connectorFixture(t)
  const preview = await f.market.inspectLocal(path.resolve('dist/connectors', key))
  f.market.installed.install(f.market.previews.read(preview.previewID), true, false)
  const owner = f.market.installed.read(preview.id)
  f.market.installed.setPermissions(preview.id, preview.revision, owner.manifest.permissions.map(item => ({ capability: item.capability, resource: item.resource, access: item.access, decision: 'allowed' as const })))
  f.market.installed.enable(preview.id)
  let instance = f.connectors.create({ connectorKey: key, identityKey: 'agent', displayName: 'Official fixture', settings, desiredState: 'disconnected' })
  if (secret) { f.credentials.set({ id: instance.id, generation: instance.generation, secret }); instance = f.connectors.read(instance.id) }
  instance = f.connectors.update({ id: instance.id, patch: { desiredState: 'connected' } })
  const grants = f.grants.read(instance.id)
  f.grants.set({ id: instance.id, generation: instance.generation, revision: grants.revision, decisions: grants.permissions.filter(item => item.resolvedResource !== null).map(item => ({ key: item.key, allowed: true })) })
  const abort = new AbortController()
  const launched = await launchComponent(instance.id, f.dataRoot, f.connectors, f.catalog, f.grants, f.events, f.credentials, abort.signal)
  f.cleanup.push(() => launched.runtime.close())
  return { ...f, instance, launched, signal: abort.signal }
}
