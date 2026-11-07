import { createHash } from 'node:crypto'
import { PLUGIN_UI_MODULE_MAX_BYTES, pluginUiDocumentSchema } from '@eden/api'
import type { PluginUiModule } from '@eden/api'
interface UiPackage {
  manifest: { id: string; name: string; components: { ui: { id: string; entry: string; enabledByDefault: boolean }[] } }
  revision: string
  files: Map<string, Buffer>
}

export function uiDocument(bytes: Buffer | undefined) {
  if (!bytes || bytes.length > 1024 * 1024) throw new Error('UI contribution document is absent or too large')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>
}

export function packageUiModules(value: UiPackage, enabled: (id: string, fallback: boolean) => boolean) {
  const result: (PluginUiModule & { source: string; resources?: Record<string, string> })[] = []
  for (const component of value.manifest.components.ui) {
    if (!enabled(component.id, component.enabledByDefault)) continue
    const raw = uiDocument(value.files.get(component.entry))
    if (raw.type !== 'module') continue
    const document = pluginUiDocumentSchema.parse(raw)
    const bytes = value.files.get(document.entry)
    if (!bytes || bytes.length > PLUGIN_UI_MODULE_MAX_BYTES) throw new Error('UI module is missing or exceeds 256 KiB')
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const resources: Record<string, string> = Object.create(null), assets: NonNullable<PluginUiModule['assets']> = Object.create(null)
    if (document.apiVersion === 2) for (const view of document.views) {
      if (!view.entry || resources[view.entry] !== undefined) continue
      const resource = value.files.get(view.entry)
      if (!resource || resource.length > 1024 * 1024) throw new Error('Extension HTML entry is missing or exceeds 1 MiB')
      resources[view.entry] = new TextDecoder('utf-8', { fatal: true }).decode(resource)
      assets[view.entry] = { sha256: createHash('sha256').update(resource).digest('hex'), byteLength: resource.length }
    }
    result.push({ pluginId: value.manifest.id, pluginName: value.manifest.name, componentId: component.id,
      revision: value.revision, sha256: createHash('sha256').update(bytes).digest('hex'), document, source,
      ...(document.apiVersion === 2 ? { assets, resources } : {}) })
  }
  return result
}
