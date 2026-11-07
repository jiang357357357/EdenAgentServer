import { extensionStateRequestSchema, type PluginUiModule, type JsonValue } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import { currentAccount } from '../accounts/index.ts'

function declaredSetting(module: PluginUiModule, input: ReturnType<typeof extensionStateRequestSchema.parse>) {
  if (module.document.apiVersion !== 2) throw new Error('Extension state requires API 2')
  if (input.namespace !== 'configuration') return undefined
  const settings = module.document.contributes.configuration
  if (!Object.hasOwn(settings, input.key)) throw new Error('Undeclared extension setting')
  const setting = settings[input.key]!
  if (input.value !== undefined && (typeof input.value !== setting.type
    || setting.enum && !setting.enum.some(value => value === input.value))) throw new Error('Invalid setting value')
  return setting
}
function storageScope(scope: 'global' | 'workspace', workspace: unknown) {
  if (scope === 'global') return 'global'
  const root = workspace && typeof workspace === 'object' && 'path' in workspace ? workspace.path : null
  if (typeof root !== 'string') throw new Error('Select a workspace before using workspace storage')
  return `workspace:${root}`
}

export class ExtensionStateRepository {
  constructor(private readonly database: EdenDatabase) {}

  access(module: PluginUiModule, raw: unknown, workspace: unknown) {
    const input = extensionStateRequestSchema.parse(raw)
    const setting = declaredSetting(module, input)
    const keys = [currentAccount()?.key ?? 'local', module.pluginId, module.componentId,
      storageScope(input.scope, workspace), input.namespace, input.key]
    const read = () => this.database.connection.prepare(`SELECT value_json,revision FROM extension_state
      WHERE account_key=? AND plugin_id=? AND component_id=? AND scope_key=? AND namespace=? AND key=?`).get(...keys)
    const result = (row: ReturnType<typeof read>) => {
      const value = row?.value_json == null ? (setting?.default ?? null) : JSON.parse(String(row.value_json)) as JsonValue
      // Preserve the old value for rollback, but never expose an incompatible setting to the new version.
      const valid = !setting || typeof value === setting.type && (!setting.enum || setting.enum.includes(value))
      return { value: valid ? value : setting!.default, revision: Number(row?.revision ?? 0) }
    }
    if (input.value === undefined && !input.remove) return result(read())
    return this.database.transaction(() => {
      const previous = read()
      if (input.expectedRevision !== undefined && Number(previous?.revision ?? 0) !== input.expectedRevision)
        throw new Error('Extension state changed; read the latest value before saving')
      const encoded = input.remove ? null : JSON.stringify(input.value)
      if (encoded && Buffer.byteLength(encoded) > 256 * 1024) throw new Error('Extension state entry exceeds 256 KiB')
      const quota = this.database.connection.prepare(`SELECT COALESCE(SUM(value_json IS NOT NULL),0) AS count,COALESCE(SUM(length(CAST(value_json AS BLOB))),0) AS bytes
        FROM extension_state WHERE account_key=? AND plugin_id=? AND component_id=? AND scope_key=?`).get(...keys.slice(0, 4))!
      const bytes = Number(quota.bytes) - Buffer.byteLength(String(previous?.value_json ?? '')) + Buffer.byteLength(encoded ?? '')
      if ((encoded !== null && previous?.value_json == null && Number(quota.count) >= 512) || bytes > 1024 * 1024)
        throw new Error('Extension storage quota exceeded')
      this.database.connection.prepare(`INSERT INTO extension_state VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(account_key,plugin_id,component_id,scope_key,namespace,key)
        DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision`)
        .run(...keys, encoded, Number(previous?.revision ?? 0) + 1)
      return result(read())
    })
  }

  configurationRevision(pluginId: string, componentId: string) {
    const row = this.database.connection.prepare(`SELECT COALESCE(SUM(revision),0) AS revision FROM extension_state
      WHERE account_key=? AND plugin_id=? AND component_id=? AND namespace='configuration'`)
      .get(currentAccount()?.key ?? 'local', pluginId, componentId)!
    return Number(row.revision)
  }
}
