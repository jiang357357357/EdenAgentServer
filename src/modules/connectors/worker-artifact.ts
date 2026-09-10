import type { ConnectorCatalog } from './catalog.ts'
export function workerArtifact(catalog: ConnectorCatalog, key: string) {
  const { component } = catalog.descriptor(key)
  if (component) return { runtime: component.runtime, packageSnapshot: { files: component.files, entrypoint: component.executablePath }, executable: '', sha256: component.sha256, args: component.args, platform: component.platform, revision: component.revision }
  throw new Error('Install, authorize and enable the owning plugin package before connecting')
}
