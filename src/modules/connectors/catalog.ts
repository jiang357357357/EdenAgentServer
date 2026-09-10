import type { InstalledPackageRepository } from '../plugin-market/index.ts'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { connectorManifestSchema as manifestSchema, toJson } from '@eden/api'
import path from 'node:path'
import { officialConnectorPackage, officialConnectorKeys } from './package-location.ts'
export class ConnectorCatalog {
  private readonly entries = new Map<string, { manifest: z.infer<typeof manifestSchema>; revision: string; packageRoot: string; pluginId: string }>()
  private componentProvider?: () => ReturnType<InstalledPackageRepository['connectorSelectionPlans']>
  attachComponentProvider(provider: () => ReturnType<InstalledPackageRepository['connectorSelectionPlans']>) { this.componentProvider = provider }
  private readonly errors: { key: string; error: string }[] = []
  constructor() {
    for (const key of officialConnectorKeys()) {
      try {
        const packageRoot = officialConnectorPackage(key)
        const bytes = readFileSync(path.join(packageRoot, 'connector.json'))
        const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
        if (manifest.id !== key) throw new Error('Connector manifest identity mismatch')
        const plugin = JSON.parse(readFileSync(path.join(packageRoot, 'plugin.json'), 'utf8')) as { id: string }
        this.entries.set(key, { pluginId: plugin.id, manifest, revision: createHash('sha256').update(bytes).digest('hex'), packageRoot })
      } catch { this.errors.push({ key, error: 'Official connector manifest is unavailable or invalid' }) }
    }
  }
  list() {
    const native = this.componentProvider?.() ?? []
    const plans = native.flatMap(item => item.plans)
    const bundled = [...this.entries.entries()].map(([key, entry]) => {
      const selected = plans.find(plan => plan.pluginId === entry.pluginId && plan.manifest.id === key)
      return { key, manifest: selected?.manifest ?? entry.manifest, revision: selected?.revision ?? entry.revision }
    })
    const entries = [...bundled, ...plans.filter(plan => ![...this.entries.entries()].some(([key, entry]) => entry.pluginId === plan.pluginId && key === plan.manifest.id))]
    return { connectors: entries.map(({ key, manifest: item, revision }) => ({ key, name: item.name,
      description: item.description, icon: item.icon, version: item.version, revision, hot_reload: false, worker_isolated: true,
      settings_schema: toJson(item.settingsSchema), capabilities: (['events', 'queries', 'actions'] as const).flatMap(kind =>
        Object.entries(item[kind]).map(([id, schema]) => ({ id, kind: kind === 'events' ? 'event' : kind === 'queries' ? 'query' : 'action',
          direction: kind === 'events' ? 'inbound' : 'outbound', label: schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.title === 'string' ? schema.title : id,
          description: '', schema, invocation: null }))) })), errors: [...this.errors, ...native.filter(item => item.error).map(item => ({ key: item.id, error: item.error! }))] }
  }
  descriptor(key: string) {
    const entry = this.entries.get(key)
    const plans = this.componentProvider?.().flatMap(item => item.plans) ?? []
    const selected = plans.find(plan => plan.key === key || (entry && plan.pluginId === entry.pluginId && plan.manifest.id === key))
    if (selected) return { manifest: selected.manifest, revision: selected.revision, packageRoot: '', component: selected }
    if (entry) return { manifest: manifestSchema.parse(entry.manifest), revision: entry.revision, packageRoot: entry.packageRoot, component: undefined }
    throw new Error('Connector component is unavailable or its plugin authorization changed')
  }

  assertEvent(key: string, eventType: string) {
    const entry = this.descriptor(key)
    if (!Object.hasOwn(entry.manifest.events, eventType)) throw new Error('Connector event is not declared in its manifest')
  }
  validate(key: string, raw: unknown) {
    const entry = this.descriptor(key)
    const shape: Record<string, z.ZodType> = {}
    for (const [name, field] of Object.entries(entry.manifest.settingsSchema.properties)) {
      if (field.type === 'boolean') shape[name] = z.boolean().optional()
      else if (field.type === 'integer') shape[name] = z.number().int().min(field.minimum ?? Number.MIN_SAFE_INTEGER).max(field.maximum ?? Number.MAX_SAFE_INTEGER).optional()
      else {
        let schema = z.string().min(field.minLength ?? 0).max(field.maxLength ?? 4096)
        if (field.pattern) schema = schema.regex(new RegExp(field.pattern))
        if (field.format === 'uuid') schema = schema.uuid()
        shape[name] = schema.optional()
      }
    }
    const value = z.object(shape).strict().parse(raw)
    const network = entry.manifest.network
    if (network?.kind === 'http' && value[network.setting.slice(9)] === undefined) value[network.setting.slice(9)] = network.fallback
    return toJson(z.object(shape).strict().parse(value))
  }
}
