import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MarketService } from './service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const permission = z.object({ capability: z.string().min(1).max(128), resource: z.string().max(4096), access: z.string().min(1).max(128) }).strict()
const request = z.object({ action: z.enum(['read', 'authorize']), id: z.string().min(1).max(128), permissions: z.array(permission).max(256).optional() }).strict()

export function pluginGrantTools(market: MarketService, approvals: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'manage_plugin_grants', revision: 'eden.plugin-grants.v1', executionMode: 'sequential',
    description: toolDescription('manage_plugin_grants'),
    parameters: toJson(z.toJSONSchema(request)) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = request.parse(raw), current = market.installed.read(input.id)
      const entries = current.permissions.map(item => ({ ...item, allowed: market.installed.permissions.allowed(current.id, current.revision, item) }))
      if (input.action === 'read') return toJson({ id: current.id, version: current.version, permissions: entries })
      const wanted = input.permissions ?? entries.filter(item => item.required)
      const selected = wanted.map(item => {
        const match = entries.find(entry => entry.capability === item.capability && entry.resource === item.resource && entry.access === item.access)
        if (!match) throw new Error('插件没有声明所选权限')
        return match
      }).filter(item => !item.allowed)
      if (new Set(selected.map(item => JSON.stringify([item.capability, item.resource, item.access]))).size !== selected.length) throw new Error('插件权限不能重复')
      if (!selected.length) return toJson({ id: current.id, version: current.version, permissions: entries })
      await approvals.request({ ...context, sessionId, turnId }, 'plugin.package.authorize', `${current.id}:${current.revision}`,
        toJson({ id: current.id, version: current.version, revision: current.revision, permissions: selected }))
      context.signal.throwIfAborted()
      if (market.installed.read(input.id).revision !== current.revision) throw new Error('插件版本在审批期间发生变化')
      market.installed.setPermissions(current.id, current.revision, selected.map(item => ({ capability: item.capability, resource: item.resource, access: item.access, decision: 'allowed' })))
      const updated = market.installed.read(input.id)
      return toJson({ id: updated.id, version: updated.version, permissions: updated.permissions.map(item => ({ ...item,
        allowed: market.installed.permissions.allowed(updated.id, updated.revision, item) })) })
    },
  }]
}
