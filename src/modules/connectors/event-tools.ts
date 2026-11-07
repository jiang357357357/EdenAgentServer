import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { ConnectorEventRepository } from './event-repository.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
const query = z.object({ eventId: z.string().uuid().optional(), before: z.number().int().safe().nonnegative().optional(),
  after: z.number().int().safe().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
export function connectorEventTools(events: ConnectorEventRepository, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'read_connector_events', revision: 'eden.connectors.events.v1', executionMode: 'sequential',
    description: toolDescription('read_connector_events'),
    parameters: toJson(z.toJSONSchema(query)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = query.parse(raw)
      if (!input.eventId) return toJson(events.listForSession(sessionId, input))
      if (input.before !== undefined || input.after !== undefined || input.limit !== undefined) throw new Error('Event detail cannot be combined with pagination')
      events.readForSession(sessionId, input.eventId)
      await permissions.request({ ...context, sessionId, turnId }, 'connector.read', input.eventId, { eventId: input.eventId })
      context.signal.throwIfAborted()
      return events.readForSession(sessionId, input.eventId)
    },
  }]
}
