import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'
import { activatePluginPackage } from './activation.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const inputSchema = z.object({ action: z.enum(['describe', 'inspect', 'install', 'list', 'status', 'enable', 'disable', 'uninstall']),
  path: z.string().min(1).max(4096).optional(), id: z.string().min(1).max(128).optional(), enabled: z.boolean().optional(),
  enableComponents: z.array(z.string().min(1).max(128)).max(128).optional() }).strict()
type Input = z.infer<typeof inputSchema>
type Context = Parameters<RuntimeTool['execute']>[1]
function summary(item: ReturnType<MarketService['installed']['read']>) {
  return { id: item.id, name: item.name, description: item.description, version: item.version, enabled: item.enabled,
    trustState: item.trustState, components: item.components, permissions: item.permissions.map(permission => ({ ...permission,
      allowed: item.permissionGrants.some(grant => grant.capability === permission.capability && grant.resource === permission.resource && grant.access === permission.access && grant.decision === 'allowed') })) }
}
export function packageTools(market: MarketService, approvals: PermissionService, sessionId: string, turnId: string, actorId?: string | number,
  backend?: (id: string, signal: AbortSignal) => Promise<unknown>): RuntimeTool[] {
  const scope = JSON.stringify(['package', sessionId, turnId, actorId ?? null])
  async function inspect(input: Input, context: Context) {
    if (!input.path) throw new Error('inspect 需要工作区插件包路径')
    await approvals.request({ ...context, sessionId, turnId }, 'plugin.package.inspect', input.path, { path: input.path })
    context.signal.throwIfAborted()
    const preview = await market.inspectLocal(input.path)
    market.rememberModelPreview(scope, preview)
    return toJson({ id: preview.id, name: preview.name, description: preview.description, version: preview.version,
      components: preview.components, permissions: preview.permissions, warnings: preview.warnings })
  }
  async function enable(id: string, input: Input, context: Context) {
    const value = await activatePluginPackage(market, approvals, id, sessionId, turnId, context, input.enableComponents)
    if (!backend) return toJson(summary(value))
    try { return toJson({ ...summary(value), backend: await backend(id, context.signal) }) }
    catch (error) { return toJson({ ...summary(market.installed.read(id)), backend: { state: 'unknown', error: String(error) } }) }
  }
  async function install(id: string, input: Input, context: Context) {
    const preview = market.modelPreview(scope, id)
    await approvals.request({ ...context, sessionId, turnId }, 'plugin.package.install', id,
      toJson({ id, version: preview.manifest.version, revision: preview.revision, components: preview.manifest.components, permissions: preview.manifest.permissions }))
    context.signal.throwIfAborted(); context.assertCurrent?.()
    const current = market.modelPreview(scope, id)
    if (current.previewID !== preview.previewID || current.revision !== preview.revision) throw new Error('插件检查快照已变化，请重新检查')
    const installed = market.installed.install(current, true, false)
    market.forgetModelPreview(scope, id)
    if (input.enabled === false) return toJson({ ...summary(installed), installed: true })
    try { return toJson({ ...(await enable(id, input, context) as Record<string, import('@eden/api').JsonValue>), installed: true }) }
    catch (error) { return toJson({ ...summary(market.installed.read(id)), installed: true, error: String(error) }) }
  }
  async function change(id: string, input: Input, context: Context) {
    if (input.action === 'enable') return enable(id, input, context)
    const current = market.installed.read(id)
    await approvals.request({ ...context, sessionId, turnId }, `plugin.package.${input.action}`, id, toJson({ id, version: current.version, revision: current.revision }))
    context.signal.throwIfAborted(); context.assertCurrent?.()
    if (market.installed.read(id).revision !== current.revision) throw new Error('插件版本在审批期间发生变化')
    return toJson(input.action === 'disable' ? summary(market.installed.disable(id)) : market.installed.remove(id))
  }
  return [{ name: 'manage_plugin_packages', revision: 'eden.plugin-packages.v1', executionMode: 'sequential',
    description: toolDescription('manage_plugin_packages'), parameters: toJson(z.toJSONSchema(inputSchema)) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = inputSchema.parse(raw)
      if (input.action === 'describe') return toJson({ workflow: '同一回合先 inspect(path)，再 install(id)；支持 UI、连接器、MCP、技能及其组合。启用与权限按宿主审批执行。',
        backends: 'MCP 和 UI 的当前格式分别参见 manage_ui_plugins.describe 的 backends 和扩展协议；连接器格式参见 manage_connector_plugins.describe。' })
      if (input.action === 'inspect') return inspect(input, context)
      if (input.action === 'list') return toJson(market.installed.list().map(summary))
      if (!input.id) throw new Error('该操作需要插件业务 ID')
      if (input.action === 'status') {
        const current = market.installed.read(input.id)
        if (!current.enabled || !backend) return toJson(summary(current))
        try { return toJson({ ...summary(current), backend: await backend(input.id, context.signal) }) }
        catch (error) { return toJson({ ...summary(market.installed.read(input.id)), backend: { state: 'unknown', error: String(error) } }) }
      }
      if (input.action === 'install') return install(input.id, input, context)
      return change(input.id, input, context)
    } }]
}
