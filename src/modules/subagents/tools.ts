import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { agentReadSchema, agentMessageSchema, agentSpawnSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { SubagentService } from './service.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
export function subagentTools(service: SubagentService, permissions: PermissionService, sessionId: string, turnId: string, actorId?: string | number): RuntimeTool[] {
  const spawn = agentSpawnSchema.pick({ taskName: true, message: true, role: true })
  const wait = agentReadSchema.extend({ timeoutMs: z.number().int().min(1).max(60000).default(30000) })
  const scope = (id: string) => service.repository.assertDescendant(sessionId, id)
  const tools: RuntimeTool[] = [{ name: 'spawn_agent', revision: 'eden.subagent.v1', executionMode: 'sequential', description: toolDescription('spawn_agent'),
    parameters: toJson(z.toJSONSchema(spawn, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = spawn.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'agent.spawn', sessionId, toJson({ ...input, ...(actorId === undefined ? {} : { actorId }) }))
      context.signal.throwIfAborted()
      return toJson(service.spawn({ ...input, sessionId, ...(actorId === undefined ? {} : { actorId }), idempotencyKey: `${turnId}:${context.callId}` }))
    } }, { name: 'send_parent_message', revision: 'eden.subagent.v1', executionMode: 'sequential', description: toolDescription('send_parent_message'),
    parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 16000 } }, required: ['message'], additionalProperties: false },
    async execute(raw, context) {
      const input = z.object({ message: z.string().trim().min(1).max(16000) }).strict().parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'agent.manage', sessionId, toJson({ action: 'send_parent_message', ...input }))
      context.signal.throwIfAborted()
      return toJson(service.sendParent(sessionId, input.message, `${turnId}:${context.callId}`))
    } }, { name: 'read_agent_messages', revision: 'eden.subagent.v1', executionMode: 'sequential', description: toolDescription('read_agent_messages'),
    parameters: { type: 'object', properties: {}, additionalProperties: false }, async execute(raw) { z.object({}).strict().parse(raw); return toJson(service.receive(sessionId)) } },
    { name: 'list_agents', revision: 'eden.subagent.v1', executionMode: 'sequential', description: toolDescription('list_agents'),
      parameters: { type: 'object', properties: {}, additionalProperties: false }, async execute(raw) { z.object({}).strict().parse(raw); return toJson(service.list(sessionId).filter(agent => { try { scope(agent.id); return true } catch { return false } })) } },
    { name: 'wait_agent', revision: 'eden.subagent.v1', executionMode: 'sequential', description: toolDescription('wait_agent'),
      parameters: toJson(z.toJSONSchema(wait, { io: 'input' })) as Record<string, JsonValue>, async execute(raw, context) {
        const input = wait.parse(raw); scope(input.agentId)
        const end = Date.now() + input.timeoutMs
        while (true) {
          context.signal.throwIfAborted(); const agent = service.read(input.agentId)
          if (!['queued', 'running'].includes(agent.status) || Date.now() >= end) return toJson({ agent, timedOut: ['queued', 'running'].includes(agent.status) })
          await delay(Math.min(500, end - Date.now()), undefined, { signal: context.signal })
        }
      } }]
  for (const action of ['send_message', 'followup_task', 'interrupt_agent'] as const) {
    const schema = action === 'interrupt_agent' ? agentReadSchema : agentMessageSchema
    tools.push({ name: action, revision: 'eden.subagent.v1', executionMode: 'sequential',
      description: toolDescription(action),
      parameters: toJson(z.toJSONSchema(schema)) as Record<string, JsonValue>, async execute(raw, context) {
        const input = schema.parse(raw); scope(input.agentId)
        await permissions.request({ ...context, sessionId, turnId }, 'agent.manage', input.agentId, toJson({ action, ...input }))
        context.signal.throwIfAborted(); scope(input.agentId)
        if (action === 'interrupt_agent') return toJson(await service.interrupt(input.agentId))
        const message = agentMessageSchema.parse(raw).message
        return toJson(action === 'send_message' ? service.send(input.agentId, message, sessionId, `${turnId}:${context.callId}`) : service.followup(input.agentId, message, `${turnId}:${context.callId}`))
      } })
  }
  return tools
}
