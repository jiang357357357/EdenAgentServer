import { z } from 'zod'
import { toJson, contactHistorySchema, ownerContactMessageSchema, ownerQqMessageSchema } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { JsonValue } from '@eden/api'
import type { PermissionService } from '../permissions/index.ts'
import type { MonBindingService } from './model-binding.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
const input = z.object({}).strict()
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
    name: 'read_recent_conversation', revision: 'eden.mon.conversation.v1', executionMode: 'sequential',
    description: toolDescription('read_recent_conversation'),
    parameters: toJson(z.toJSONSchema(input)) as Record<string, JsonValue>,
    async execute(raw, context) {
      input.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'contact.read', 'owner-recent-conversation', {})
      context.signal.throwIfAborted()
      return mon.recentConversation(sessionId)
    },
  }, {
    name: 'send_qq_message', revision: 'eden.mon.contacts.v1', executionMode: 'sequential',
    description: toolDescription('send_qq_message'),
    parameters: toJson(z.toJSONSchema(ownerQqMessageSchema, { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      const message = ownerQqMessageSchema.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'contact.qq', 'owner-default-qq', toJson(message))
      context.signal.throwIfAborted()
      return mon.contactOwnerByQq(sessionId, { ...message, requestId: `${turnId}:${context.callId}` }, context.signal)
    },
  }, {
    name: 'read_qq_messages', revision: 'eden.mon.qq-history.v2', executionMode: 'sequential',
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
    parameters: toJson(z.toJSONSchema(ownerContactMessageSchema)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const message = ownerContactMessageSchema.parse(raw)
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
