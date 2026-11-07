import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { connectorPluginGuide } from '../../model-prompts/plugin-development.ts'
import { activatePluginPackage } from './activation.ts'

const request = z.object({ action: z.enum(['describe', 'inspect', 'install', 'enable', 'disable', 'list']), args: z.record(z.string(), z.unknown()) }).strict()
const identity = z.object({ id: z.string().min(1).max(128), enableComponents: z.array(z.string().min(1).max(128)).max(128).optional() }).strict()

export function connectorPluginTools(market: MarketService, permissions: PermissionService, sessionId: string, turnId: string, actorId?: string | number): RuntimeTool[] {
  const scope = JSON.stringify([sessionId, turnId, actorId ?? null])
  return [{ name: 'manage_connector_plugins', revision: 'eden.connector-plugin.v1', executionMode: 'sequential',
    description: toolDescription('manage_connector_plugins'),
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['describe', 'inspect', 'install', 'enable', 'disable', 'list'] }, args: { type: 'object' } }, required: ['action', 'args'], additionalProperties: false },
    async execute(raw, context) {
      const input = request.parse(raw)
      if (input.action === 'describe') return connectorPluginGuide()
      if (input.action === 'list') return toJson(market.installed.list())
      if (input.action === 'install') return installCheckedConnector(market, permissions, scope, sessionId, turnId, input.args, context)
      if (input.action === 'enable') {
        const args = identity.parse(input.args)
        return toJson(await activatePluginPackage(market, permissions, args.id, sessionId, turnId, context, args.enableComponents))
      }
      await permissions.request({ ...context, sessionId, turnId }, `plugin.connector.${input.action}`, 'plugin-registry', toJson(input.args))
      context.signal.throwIfAborted()
      if (input.action === 'inspect') {
        const preview = await market.inspectLocal(z.object({ path: z.string().min(1).max(4096) }).strict().parse(input.args).path)
        market.rememberModelPreview(scope, preview)
        return toJson(preview)
      }
      const { id } = identity.parse(input.args)
      return toJson(market.installed.disable(id))
    }
  }]
}

async function installCheckedConnector(market: MarketService, permissions: PermissionService, scope: string, sessionId: string,
  turnId: string, args: unknown, context: Parameters<RuntimeTool['execute']>[1]) {
  const { id } = identity.parse(args)
  const preview = market.modelPreview(scope, id)
  if (!preview.manifest.components.runtimes.some(item => item.kind === 'connector')) throw new Error('该包没有 TS 连接器组件')
  await permissions.request({ ...context, sessionId, turnId }, 'plugin.connector.install', 'plugin-registry',
    { id, version: preview.manifest.version, revision: preview.revision, previewID: preview.previewID })
  context.signal.throwIfAborted()
  const current = market.modelPreview(scope, id)
  if (current.previewID !== preview.previewID || current.revision !== preview.revision) throw new Error('连接器包检查快照在审批期间发生变化')
  const installed = market.installed.install(current, true, false)
  market.forgetModelPreview(scope, id)
  return toJson(installed)
}
