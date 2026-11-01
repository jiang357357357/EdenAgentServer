import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import type { NapcatClient, NapcatSessionTarget } from './napcat-client.ts'
import type { NapcatResult } from './napcat-transport.ts'
import { qqBotIdDescription } from '../../model-prompts/qq-targets.ts'
import { qqModelResult } from '../tool-results/index.ts'
import { qqReferenceDescription } from '../../model-prompts/qq-results.ts'
import { napcatOutcome } from './napcat-outcome.ts'

const action = z.string().regex(/^_?[a-z][a-z0-9_]{0,79}$/)
const bot = z.string().regex(/^[1-9]\d{0,19}$/).optional().describe(qqBotIdDescription)
const capabilityInput = z.object({ bot_id: bot, action: action.optional() }).strict()
const actionInput = z.object({ bot_id: bot, action, params: z.record(z.string(), z.unknown()) }).strict()
const eventInput = z.object({ bot_id: bot, event_type: z.string().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(256).optional().describe(qqReferenceDescription) }).strict()
type ToolContext = Parameters<RuntimeTool['execute']>[1]

export function napcatTools(client: NapcatClient, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  // This map is host-only. Projection runs after the original receipt has reached durable audit callbacks.
  const receipts = new Map<string, NapcatSessionTarget>()
  const key = (raw: Record<string, unknown>) => JSON.stringify([raw.request_id, raw.action, raw.bot_id])
  const reply = (target: NapcatSessionTarget, result: NapcatResult): JsonValue => {
    const raw = { ...result, ...(target.botId ? { bot_id: target.botId } : {}) }
    receipts.set(key(raw), target)
    return toJson(raw)
  }
  const modelResult = (raw: JsonValue): JsonValue => {
    const target = raw && typeof raw === 'object' && !Array.isArray(raw) ? receipts.get(key(raw)) : undefined
    return qqModelResult(target ? client.modelReceipt(target, raw as NapcatResult) : raw)
  }
  const approve = async (context: ToolContext, capability: string, resource: string, details: unknown) => {
    await permissions.request({ ...context, sessionId, turnId }, capability, resource, toJson(details))
    context.signal.throwIfAborted()
  }
  const resolve = async (context: ToolContext, botId?: string, requireOnline = false) => {
    const target = client.target(sessionId, botId, turnId)
    if (target.discovery) await approve(context, 'qq.napcat.read', target.resource, { channel: 'qq_bot_discovery' })
    return client.resolve(target, context.signal, requireOnline)
  }
  return [{ name: 'list_qq_capabilities', revision: 'eden.qq.actions.v3', executionMode: 'sequential',
    description: toolDescription('list_qq_capabilities'), modelResult, outcome: napcatOutcome,
    parameters: toJson(z.toJSONSchema(capabilityInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = capabilityInput.parse(raw), resolved = await resolve(context, input.bot_id)
      if (!('target' in resolved)) return toJson(resolved)
      const { target } = resolved
      await approve(context, 'qq.napcat.read', target.resource,
        { ...input, bot: target.qqContext?.bot_qq ?? target.botId })
      return reply(target, await client.capabilities(target, `${turnId}:${context.callId}`, context.signal, input.action))
    },
  }, { name: 'list_qq_events', revision: 'eden.qq.actions.v3', executionMode: 'sequential',
    description: toolDescription('list_qq_events'), modelResult, outcome: napcatOutcome,
    parameters: toJson(z.toJSONSchema(eventInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = eventInput.parse(raw), resolved = await resolve(context, input.bot_id)
      if (!('target' in resolved)) return toJson(resolved)
      const { target } = resolved
      await approve(context, 'qq.napcat.read', target.resource, { ...input, bot: target.qqContext?.bot_qq ?? target.botId })
      const params = client.resolveParams(target, { ...(input.event_type ? { type: input.event_type } : {}),
        ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.cursor ? { cursor: input.cursor } : {}) })
      return reply(target, await client.events(target, params, `${turnId}:${context.callId}`, context.signal))
    },
  }, ...(['read', 'write'] as const).map(mode => ({
    name: mode === 'read' ? 'read_qq_action' : 'execute_qq_action', revision: 'eden.qq.actions.v3', executionMode: 'sequential' as const,
    description: toolDescription(mode === 'read' ? 'read_qq_action' : 'execute_qq_action'), modelResult, outcome: napcatOutcome,
    parameters: toJson(z.toJSONSchema(actionInput)) as Record<string, JsonValue>,
    async execute(raw: Record<string, unknown>, context: ToolContext) {
      const input = actionInput.parse(raw), resolved = await resolve(context, input.bot_id, true)
      if (!('target' in resolved)) return toJson(resolved)
      const { target } = resolved
      const params = client.resolveParams(target, input.params)
      await approve(context, `qq.napcat.${mode}`, `${target.resource}:${input.action}`,
        { ...input, params, channel: 'qq_action', bot: target.qqContext?.bot_qq ?? target.botId })
      return reply(target, await client.execute(target, input.action, params, mode, `${turnId}:${context.callId}`, context.signal, context.assertCurrent))
    },
  }))]
}
