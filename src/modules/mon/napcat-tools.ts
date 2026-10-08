import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import type { NapcatClient } from './napcat-client.ts'
import { napcatJson } from './napcat-transport.ts'

const action = z.string().regex(/^_?[a-z][a-z0-9_]{0,79}$/)
const bot = z.string().regex(/^[1-9]\d{0,19}$/).optional()
const capabilityInput = z.object({ bot_id: bot, action: action.optional() }).strict()
const actionInput = z.object({ bot_id: bot, action, params: z.record(z.string(), z.unknown()) }).strict()
const eventInput = z.object({ bot_id: bot, event_type: z.string().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(256).optional() }).strict()
type ToolContext = Parameters<RuntimeTool['execute']>[1]

export function napcatTools(client: NapcatClient, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  const approve = async (context: ToolContext, capability: string, resource: string, details: unknown) => {
    await permissions.request({ ...context, sessionId, turnId }, capability, resource, toJson(details))
    context.signal.throwIfAborted()
  }
  return [{ name: 'list_qq_capabilities', revision: 'eden.qq.actions.v1', executionMode: 'sequential',
    description: toolDescription('list_qq_capabilities'),
    parameters: toJson(z.toJSONSchema(capabilityInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = capabilityInput.parse(raw), target = client.target(sessionId, input.bot_id)
      await approve(context, target.qqContext?.group_qq ? 'qq.napcat.group.read' : 'qq.napcat.read', target.resource, input)
      return napcatJson(await client.capabilities(target, `${turnId}:${context.callId}`, context.signal, input.action))
    },
  }, { name: 'list_qq_events', revision: 'eden.qq.actions.v1', executionMode: 'sequential',
    description: toolDescription('list_qq_events'),
    parameters: toJson(z.toJSONSchema(eventInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = eventInput.parse(raw), target = client.target(sessionId, input.bot_id)
      if (target.qqContext?.group_qq) throw new Error('群会话不能读取整个机器人的事件记录')
      await approve(context, 'qq.napcat.read', target.resource, input)
      const params = { ...(input.event_type ? { type: input.event_type } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor ? { cursor: input.cursor } : {}) }
      return napcatJson(await client.events(target, params, `${turnId}:${context.callId}`, context.signal))
    },
  }, ...(['read', 'write'] as const).map(mode => ({
    name: mode === 'read' ? 'read_qq_action' : 'execute_qq_action', revision: 'eden.qq.actions.v1', executionMode: 'sequential' as const,
    description: toolDescription(mode === 'read' ? 'read_qq_action' : 'execute_qq_action'),
    parameters: toJson(z.toJSONSchema(actionInput)) as Record<string, JsonValue>,
    async execute(raw: Record<string, unknown>, context: ToolContext) {
      const input = actionInput.parse(raw), target = client.target(sessionId, input.bot_id)
      const params = client.groupParams(target, input.params, mode)
      const scope = target.qqContext?.group_qq ? 'qq.napcat.group' : 'qq.napcat'
      await approve(context, `${scope}.${mode}`, `${target.resource}:${input.action}`,
        { ...input, params, channel: 'qq_action', bot: target.qqContext?.bot_qq ?? input.bot_id })
      return napcatJson(await client.execute(target, input.action, params, mode, `${turnId}:${context.callId}`, context.signal))
    },
  }))]
}
