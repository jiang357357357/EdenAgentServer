import { z } from 'zod'
import { toJson, contactHistorySchema } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { JsonValue } from '@eden/api'
import type { PermissionService } from '../permissions/index.ts'
import type { MonBindingService } from './model-binding.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
const input = z.object({}).strict()
const ownerEmailInput = z.object({
  title: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(16000),
}).strict()
export function contactTools(mon: MonBindingService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'list_contact_channels', revision: 'eden.mon.contacts.v1', executionMode: 'sequential',
    description: toolDescription('list_contact_channels'),
    parameters: toJson(z.toJSONSchema(input)) as Record<string, JsonValue>,
    async execute(raw, context) {
      input.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'contact.read', 'owner-channels', {})
      return mon.contactChannels(sessionId, context.signal)
    },
  }, {
    name: 'read_qq_messages', revision: 'eden.mon.contacts.v1', executionMode: 'sequential',
    description: toolDescription('read_qq_messages'),
    parameters: toJson(z.toJSONSchema(contactHistorySchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const query = contactHistorySchema.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'contact.read', 'owner-qq-history', toJson(query))
      context.signal.throwIfAborted()
      return mon.readContactHistory(sessionId, query, context.signal)
    },
  }, {
    name: 'send_external_email', revision: 'eden.mon.contacts.v1', executionMode: 'sequential',
    description: toolDescription('send_external_email'),
    parameters: toJson(z.toJSONSchema(ownerEmailInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const message = ownerEmailInput.parse(raw)
      await permissions.request(
        { ...context, sessionId, turnId },
        'contact.email',
        'owner-default-email',
        toJson(message),
      )
      context.signal.throwIfAborted()
      return mon.contactOwnerByEmail(sessionId, {
        ...message,
        requestId: `${turnId}:${context.callId}`,
      }, context.signal)
    },
  }]
}
