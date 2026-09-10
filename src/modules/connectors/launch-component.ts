import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { launchConnectorProcess } from '@eden/execution'
import type { ConnectorCatalog } from './catalog.ts'
import type { ConnectorRepository } from './repository.ts'
import type { ConnectorPermissions } from './permissions.ts'
import type { ConnectorEventRepository } from './event-repository.ts'
import type { ConnectorCredentials } from './credentials.ts'
import { connectorMounts } from './mount-bindings.ts'
import { connectorNetworkBinding } from './network-binding.ts'
import { workerArtifact } from './worker-artifact.ts'
import { prepareWorker } from './prepare-worker.ts'
import { ConnectorWorkerRuntime } from './worker-runtime.ts'

export async function launchComponent(id: string, dataRoot: string, repository: ConnectorRepository, catalog: ConnectorCatalog,
  permissions: ConnectorPermissions, events: ConnectorEventRepository, credentials: ConnectorCredentials, signal: AbortSignal) {
  const current = repository.read(id), descriptor = catalog.descriptor(current.connectorKey)
  const artifact = workerArtifact(catalog, current.connectorKey), granted = permissions.require(id, current.generation)
  const authorize = () => {
    signal.throwIfAborted()
    const latest = repository.read(id), snapshot = permissions.read(id)
    if (latest.generation !== current.generation || latest.desiredState !== 'connected' || !snapshot.ready || snapshot.revision !== artifact.revision) throw new Error('Connector component authorization changed')
    const allowed = permissions.require(id, current.generation)
    if (granted.some(original => !allowed.some(item => item.capability === original.capability && item.resource === original.resource && item.access === original.access))) throw new Error('Connector resource permission was revoked')
  }
  authorize()
  const mounts = await connectorMounts(dataRoot, current.settings, descriptor, granted)
  const identity = granted.some(item => item.resource === 'connector.identityCredential' && item.capability === 'environment.read' && item.access === 'read')
    ? { key: current.identityKey, credential: credentials.forWorker(id, current.generation, permissions) } : undefined
  const directory = path.join(dataRoot, 'connectors', id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const network = await connectorNetworkBinding(descriptor.manifest, current.settings, granted, dataRoot, authorize, signal)
  let prepared: Awaited<ReturnType<typeof prepareWorker>> | undefined
  let child: Awaited<ReturnType<typeof launchConnectorProcess>> | undefined
  try {
    prepared = await prepareWorker(catalog, current.connectorKey, dataRoot, artifact.revision)
    authorize(); network?.assertCurrent()
    child = await launchConnectorProcess({ runtime: artifact.runtime, executable: prepared.executable, packageSnapshot: prepared.packageSnapshot,
      sha256: artifact.sha256, args: artifact.args, dataDirectory: directory, readMounts: mounts.readMounts, writeMounts: mounts.writeMounts,
      ...(identity ? { identity } : {}), ...(network ? { networkBridgeDirectory: network.directory } : {}), signal })
    const process = child
    const exited = process.exited.finally(async () => { try { await network?.close() } finally { await prepared?.cleanup() } })
    void exited.catch(() => { globalThis.process.stderr.write('Connector component cleanup failed\n') })
    const runtime = new ConnectorWorkerRuntime(id, current.generation, process.input, process.output, repository, events,
      async () => { await process.stop(); await exited }, () => { authorize(); network?.assertCurrent() }, descriptor.manifest.id)
    try {
      await runtime.initialize({ protocolVersion: 1, connectorInstanceId: id, connectorKey: descriptor.manifest.id,
        packageVersion: descriptor.manifest.version, settings: { ...mounts.workerSettings, ...network?.settings },
        grantedPermissions: mounts.workerGrants, dataDirectory: directory }, current.settings)
      authorize()
    } catch (error) { await runtime.close(); throw error }
    return { runtime, generation: current.generation, revision: artifact.revision, exited }
  } catch (error) {
    try { await child?.stop() } finally { try { await network?.close() } finally { await prepared?.cleanup() } }
    throw error
  }
}
