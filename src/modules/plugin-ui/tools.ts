import { z } from 'zod'
import path from 'node:path'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { MarketService } from '../plugin-market/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import { uiPluginGuide, UI_PLUGIN_TOOL_DESCRIPTION } from '../../model-prompts/ui-plugins.ts'
import { packageUiModules, activatePluginPackage } from '../plugin-market/index.ts'
import type { McpLifecycle } from '../mcp/index.ts'

const actionSchema = z.object({ action: z.enum(['describe', 'list', 'status', 'diagnostics', 'inspect', 'install', 'enable', 'disable', 'uninstall']),
  path: z.string().min(1).max(4096).optional(), id: z.string().min(1).max(128).optional(), enabled: z.boolean().optional(),
  enableComponents: z.array(z.string().min(1).max(128)).max(128).optional() }).strict()
function modelPackage(value: ReturnType<MarketService['installed']['read']>) {
  return { id: value.id, name: value.name, description: value.description, version: value.version,
    enabled: value.enabled, components: value.components,
    permissions: value.permissions.map(item => ({ ...item, allowed: value.permissionGrants.some(grant =>
      grant.capability === item.capability && grant.resource === item.resource && grant.access === item.access && grant.decision === 'allowed') })) }
}
function modelBackends(mcp?: McpLifecycle) {
  const status = mcp?.list()
  return status && { runtimes: status.runtimes.map(({ id, pluginId, componentId, kind, server }) => ({ id, pluginId, componentId, kind, server })), errors: status.errors }
}
export function uiPluginTools(market: MarketService, permissions: PermissionService,
  sessionId: string, turnId: string, actorId?: string | number, status: () => unknown = () => [], mcp?: McpLifecycle,
  diagnostics: (id?: string) => unknown = () => ({ entries: [], operations: [] }), workspaceRoot?: () => string): RuntimeTool[] {
  const scope = JSON.stringify(['ui', sessionId, turnId, actorId ?? null])
  return [{ name: 'manage_ui_plugins', revision: 'eden.ui-plugin.v1', executionMode: 'sequential',
    description: UI_PLUGIN_TOOL_DESCRIPTION,
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['describe', 'list', 'status', 'diagnostics', 'inspect', 'install', 'enable', 'disable', 'uninstall'] },
      path: { type: 'string' }, id: { type: 'string' }, enabled: { type: 'boolean' },
      enableComponents: { type: 'array', items: { type: 'string' } },
    }, required: ['action'], additionalProperties: false },
    async execute(raw, context) {
      const input = actionSchema.parse(raw)
      if (input.action === 'describe') return toJson(uiPluginGuide())
      if (input.action === 'status') return toJson({ reports: status(), plugins: market.installed.list().map(modelPackage),
        backends: modelBackends(mcp), note: '加载、启用、后台就绪与业务成功是不同状态；组件 disabled 或后台报错时不能声称可用。' })
      if (input.action === 'diagnostics') return toJson(diagnostics(input.id))
      if (input.action === 'list') return toJson(market.installed.list()
        .filter(item => item.components.some(component => component.kind === 'ui')).map(modelPackage))
      if (input.action === 'inspect') {
        return inspectUiPlugin(market, permissions, { sessionId, turnId, scope, context, workspaceRoot }, input.path)
      }
      if (!input.id) throw new Error('This action requires a plugin id')
      if (input.action === 'install') {
        const result = await installUiPlugin(market, permissions, scope, sessionId, turnId, input.id, input.enabled !== false, context, input.enableComponents)
        return result.enabled ? toJson({ ...result, backend: await mcp?.waitForPackage(input.id, context.signal) }) : toJson(result)
      }
      const current = market.installed.read(input.id)
      if (!current.components.some(item => item.kind === 'ui')) throw new Error('Package has no UI component')
      if (input.action === 'enable') {
        const value = await activatePluginPackage(market, permissions, input.id, sessionId, turnId, context, input.enableComponents)
        return toJson({ ...modelPackage(value), backend: await mcp?.waitForPackage(input.id, context.signal) })
      }
      await permissions.request({ ...context, sessionId, turnId }, `plugin.ui.${input.action}`, input.id, { id: input.id, revision: current.revision })
      context.signal.throwIfAborted()
      if (market.installed.read(input.id).revision !== current.revision) throw new Error('插件版本在审批期间发生变化')
      if (input.action === 'uninstall') return toJson(market.installed.remove(input.id))
      return modelPackage(market.installed.disable(input.id))
    },
  }]
}
async function inspectUiPlugin(market: MarketService, permissions: PermissionService,
  binding: { sessionId: string; turnId: string; scope: string; context: Parameters<RuntimeTool['execute']>[1]; workspaceRoot: (() => string) | undefined }, requested?: string) {
  if (!requested) throw new Error('inspect requires a workspace package path')
  const relative = !path.isAbsolute(requested), root = relative ? binding.workspaceRoot?.() : undefined
  if (relative && !root) throw new Error('Select a workspace before inspecting a relative plugin path')
  const source = relative ? path.resolve(root!, requested) : requested
  const { context, sessionId, turnId, scope } = binding
  await permissions.request({ ...context, sessionId, turnId }, 'plugin.ui.inspect', source, { path: requested, resolvedPath: source })
  context.signal.throwIfAborted()
  if (relative && binding.workspaceRoot?.() !== root) throw new Error('Workspace changed while approving plugin inspection')
  const preview = await market.inspectLocal(source), frozen = market.previews.read(preview.previewID)
  const modules = packageUiModules(frozen, () => true)
  if (!modules.length) { market.previews.discard(preview.previewID); throw new Error('该包没有可执行的前端模块') }
  market.rememberModelPreview(scope, preview)
  return toJson({ id: preview.id, name: preview.name, version: preview.version,
    components: preview.components, permissions: preview.permissions,
    modules: modules.map(item => ({ componentId: item.componentId, document: item.document })), warnings: preview.warnings })
}
async function installUiPlugin(market: MarketService, permissions: PermissionService, scope: string, sessionId: string,
  turnId: string, id: string, enabled: boolean, context: Parameters<RuntimeTool['execute']>[1], enableComponents?: string[]) {
  const preview = market.modelPreview(scope, id), modules = packageUiModules(preview, () => true)
  if (!modules.length) throw new Error('Inspected package contains no UI modules')
  await permissions.request({ ...context, sessionId, turnId }, 'plugin.ui.install', id,
    toJson({ id, version: preview.manifest.version, revision: preview.revision, modules: modules.map(item => item.document), enabled }))
  context.signal.throwIfAborted()
  const current = market.modelPreview(scope, id)
  if (current.revision !== preview.revision || current.previewID !== preview.previewID) throw new Error('检查快照在审批期间发生变化，请重新检查')
  const installed = market.installed.install(current, true, false)
  market.forgetModelPreview(scope, id)
  if (!enabled) return { ...modelPackage(installed), installed: true }
  try { return { ...modelPackage(await activatePluginPackage(market, permissions, id, sessionId, turnId, context, enableComponents)), installed: true } }
  catch (error) { return { ...modelPackage(market.installed.read(id)), installed: true, enabled: false, error: String(error) } }
}
