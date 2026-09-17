import type { InstalledPackageRepository } from '../plugin-market/index.ts'
import { z } from 'zod'
import { toJson } from '@eden/api'
export class ConnectorCatalog {
  private componentProvider?: () => ReturnType<InstalledPackageRepository['connectorSelectionPlans']>
  attachComponentProvider(provider: () => ReturnType<InstalledPackageRepository['connectorSelectionPlans']>) { this.componentProvider = provider }
  list() {
    const native = this.componentProvider?.() ?? []
    const plans = native.flatMap(item => item.plans)
    const entries = plans
    return { connectors: entries.map(({ key, manifest: item, revision }) => ({ key, name: item.name,
      description: item.description, icon: item.icon, version: item.version, revision, hot_reload: false, worker_isolated: true,
      settings_schema: toJson(item.settingsSchema), capabilities: (['events', 'queries', 'actions'] as const).flatMap(kind =>
        Object.entries(item[kind]).map(([id, schema]) => ({ id, kind: kind === 'events' ? 'event' : kind === 'queries' ? 'query' : 'action',
          direction: kind === 'events' ? 'inbound' : 'outbound', label: schema && typeof schema === 'object' && !Array.isArray(schema) && typeof schema.title === 'string' ? schema.title : id,
          description: '', schema, invocation: null }))) })), errors: [...native.filter(item => item.error).map(item => ({ key: item.id, error: item.error! }))] }
  }
  descriptor(key: string) {
    const plans = this.componentProvider?.().flatMap(item => item.plans) ?? []
    const selected = plans.find(plan => plan.key === key)
    if (selected) return { manifest: selected.manifest, revision: selected.revision, packageRoot: '', component: selected }
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
