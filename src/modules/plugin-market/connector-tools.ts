import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { connectorPluginGuide } from '../../model-prompts/plugin-development.ts'

const request = z.object({ action: z.enum(['describe', 'inspect', 'install', 'enable', 'disable', 'list']), args: z.record(z.string(), z.unknown()) }).strict()
const identity = z.object({ id: z.string().min(1).max(128) }).strict()

export function connectorPluginTools(market: MarketService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'manage_connector_plugins', revision: 'eden.connector-plugin.v1', executionMode: 'sequential',
    description: toolDescription('manage_connector_plugins'),
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['describe', 'inspect', 'install', 'enable', 'disable', 'list'] }, args: { type: 'object' } }, required: ['action', 'args'], additionalProperties: false },
    async execute(raw, context) {
      const input = request.parse(raw)
      if (input.action === 'describe') return connectorPluginGuide()
      if (input.action === 'list') return toJson(market.installed.list())
      await permissions.request({ ...context, sessionId, turnId }, `plugin.connector.${input.action}`, 'plugin-registry', toJson(input.args))
      context.signal.throwIfAborted()
      if (input.action === 'inspect') return toJson(await market.inspectLocal(z.object({ path: z.string().min(1).max(4096) }).strict().parse(input.args).path))
      if (input.action === 'install') {
        const { previewID } = z.object({ previewID: z.string().uuid() }).strict().parse(input.args)
        const preview = market.previews.read(previewID)
        if (!preview.manifest.components.runtimes.some(item => item.kind === 'connector')) throw new Error('该包没有 TS 连接器组件')
        return toJson(market.installed.install(preview, true, false))
      }
      const { id } = identity.parse(input.args)
      return toJson(input.action === 'enable' ? market.installed.enable(id) : market.installed.disable(id))
    }
  }]
}
