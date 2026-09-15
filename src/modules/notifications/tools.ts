import { z } from 'zod'
import { desktopReminderCreateSchema, desktopReminderIdSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { DesktopReminderRepository } from './repository.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

export function desktopReminderTools(repository: DesktopReminderRepository, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{ name: 'show_desktop_reminder', revision: 'eden.desktop-reminder.v1', executionMode: 'sequential',
    description: toolDescription('show_desktop_reminder'),
    parameters: toJson(z.toJSONSchema(desktopReminderCreateSchema)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = desktopReminderCreateSchema.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'desktop.notify', sessionId, toJson(input))
      context.signal.throwIfAborted()
      return toJson(repository.create(sessionId, turnId, input, `tool:${sessionId}:${turnId}:${context.callId}`))
    },
  }, { name: 'get_desktop_reminder', revision: 'eden.desktop-reminder.v1', executionMode: 'sequential',
    description: toolDescription('get_desktop_reminder'),
    parameters: toJson(z.toJSONSchema(desktopReminderIdSchema)) as Record<string, JsonValue>,
    async execute(raw, context) {
      context.signal.throwIfAborted()
      const reminder = repository.read(desktopReminderIdSchema.parse(raw).id)
      if (reminder.sessionId !== sessionId) throw new Error('该提醒属于其他会话')
      return toJson(reminder)
    },
  }]
}
