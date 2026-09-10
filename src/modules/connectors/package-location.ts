import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

declare const EDEN_BUNDLED_SERVER: boolean
function roots() {
  if (typeof EDEN_BUNDLED_SERVER !== 'undefined' && EDEN_BUNDLED_SERVER) return { built: fileURLToPath(new URL('../connectors/', import.meta.url)), source: undefined }
  return { built: fileURLToPath(new URL('../../../../dist/connectors/', import.meta.url)), source: fileURLToPath(new URL('../../../connectors/official/', import.meta.url)) }
}
export function officialConnectorKeys() {
  const locations = roots()
  return [...new Set([locations.built, locations.source].flatMap(root => root && existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-z][a-z0-9.-]*$/.test(entry.name)).map(entry => entry.name) : []))].sort()
}
export function officialConnectorPackage(key: string) {
  if (!/^[a-z][a-z0-9.-]*$/.test(key)) throw new Error('Invalid connector package key')
  const locations = roots(), built = path.join(locations.built, key)
  if (existsSync(built) || !locations.source) return built
  return path.join(locations.source, key, 'package')
}
