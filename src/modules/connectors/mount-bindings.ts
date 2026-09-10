import { realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import type { ConnectorPermissions } from './permissions.ts'
import type { ConnectorCatalog } from './catalog.ts'

/** Resolve approved settings to host paths. Sandbox path rewriting is paused pending developer review. */
export async function connectorMounts(dataRoot: string, settings: Record<string, unknown>, descriptor: ReturnType<ConnectorCatalog['descriptor']>, grants: ReturnType<ConnectorPermissions['require']>) {
  const workerSettings = { ...settings }, readMounts: { source: string; target: string }[] = [], writeMounts: { source: string; target: string }[] = []
  const workerGrants: { capability: string; resource: string; access: string }[] = []
  const privateRoot = await realpath(dataRoot)
  for (const permission of descriptor.manifest.permissions) {
    const key = permission.resource.startsWith('settings.') ? permission.resource.slice(9) : null
    const resource = key ? settings[key] : permission.resource
    const granted = grants.some(item => item.capability === permission.capability && item.resource === resource && item.access === permission.access)
    if (!granted) { if (key) delete workerSettings[key]; continue }
    if (permission.capability === 'network.connect' || (permission.capability === 'environment.read' && resource === 'connector.identityCredential')) {
      workerGrants.push({ capability: permission.capability, resource: String(resource), access: permission.access }); continue
    }
    if (!key || typeof resource !== 'string' || !['filesystem.read', 'filesystem.write'].includes(permission.capability)) throw new Error('Connector plugin requires a dedicated adapter for non-filesystem permissions')
    const { write, source } = await resolveConnectorMount(resource, permission, privateRoot, dataRoot)
    if (workerGrants.length >= 16) throw new Error('Connector plugin exceeds mount count limit')
    const target = source
    const mounts = write ? writeMounts : readMounts
    mounts.push({ source, target })
    workerSettings[key] = target
    workerGrants.push({ capability: permission.capability, resource: target, access: permission.access })
  }
  return { workerSettings, readMounts, writeMounts, workerGrants }
}

async function resolveConnectorMount(resource: string, permission: { capability: string; resource: string; access: string; required: boolean; description: string }, privateRoot: string, dataRoot: string) {
  const source = await realpath(resource), info = await lstat(source), write = permission.capability === 'filesystem.write'
  if (!path.isAbsolute(resource) || (await lstat(resource)).isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (write && !info.isDirectory())) throw new Error('Connector plugin mount has an invalid path or type')
  const protectedRoots = [privateRoot, path.resolve(dataRoot, '..', '..'), path.resolve('Data'), '/proc', '/dev', '/sys', '/etc']
  if (write) protectedRoots.push('/usr', '/bin', '/sbin', '/lib', '/lib64')
  if (source === path.parse(source).root || protectedRoots.some(root => source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep))) throw new Error('Connector plugin mount overlaps private or protected host data')
  if ((write && permission.access !== 'write') || (!write && permission.access !== 'read')) throw new Error('Connector plugin mount access does not match its capability')
  return { write, source }
}
