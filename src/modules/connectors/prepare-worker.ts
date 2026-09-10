import type { ConnectorCatalog } from './catalog.ts'
import { workerArtifact } from './worker-artifact.ts'

/** Pass immutable package bytes to the isolation owner; never mount a mutable plugin installation directory. */
export async function prepareWorker(catalog: ConnectorCatalog, key: string, _dataRoot: string, expectedRevision: string) {
  const descriptor = catalog.descriptor(key), artifact = workerArtifact(catalog, key)
  if (artifact.revision !== expectedRevision) throw new Error('Worker changed before executable preparation')
  if (!descriptor.component) return { executable: artifact.executable, packageSnapshot: artifact.packageSnapshot, async cleanup() {} }
  if (descriptor.component.revision !== expectedRevision || descriptor.component.sha256 !== artifact.sha256) throw new Error('Native worker plan changed during preparation')
  return { executable: '', packageSnapshot: { files: descriptor.component.files, entrypoint: descriptor.component.executablePath }, async cleanup() {} }
}
