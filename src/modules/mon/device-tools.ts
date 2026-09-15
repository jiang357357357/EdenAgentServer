import { z } from 'zod'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MonBindingService } from './model-binding.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const emptyInput = z.object({}).strict()
const deviceId = z.number().int().positive()
const commandIdInput = z.object({ commandId: z.string().uuid() }).strict()
const commandVariant = z.discriminatedUnion('action', [
  z.object({
    deviceId,
    action: z.literal('call.start'),
    reason: z.string().trim().min(1).max(200).optional(),
    currentSituation: z.string().trim().min(1).max(1000).optional(),
    suggestedOpening: z.string().trim().min(1).max(300).optional(),
  }).strict(),
  z.object({
    deviceId,
    action: z.literal('message.send'),
    text: z.string().trim().min(1).max(1000),
  }).strict(),
  z.object({
    deviceId,
    action: z.literal('notification.show'),
    title: z.string().trim().min(1).max(80).optional(),
    text: z.string().trim().min(1).max(300),
    durationMs: z.number().int().min(1000).max(60000).optional(),
  }).strict(),
])
const commandInput = z.object({
  deviceId,
  action: z.enum(['call.start', 'message.send', 'notification.show']),
  text: z.string().trim().min(1).max(1000).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  durationMs: z.number().int().min(1000).max(60000).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
  currentSituation: z.string().trim().min(1).max(1000).optional(),
  suggestedOpening: z.string().trim().min(1).max(300).optional(),
}).strict()

type DeviceCommand = z.infer<typeof commandVariant>

function commandArguments(input: DeviceCommand): Record<string, JsonValue> {
  if (input.action === 'call.start') {
    const reason = input.reason
    const suggestedOpening = input.suggestedOpening
    return {
      ...(reason ? { reason } : {}),
      ...(input.currentSituation ? { current_situation: input.currentSituation } : {}),
      ...(suggestedOpening ? { suggested_opening: suggestedOpening } : {}),
    }
  }
  if (input.action === 'message.send') return { text: input.text }
  if (input.action === 'notification.show') {
    return {
      title: input.title ?? '提示',
      text: input.text,
      duration_ms: input.durationMs ?? 5000,
    }
  }
  return {}
}

export function deviceTools(mon: MonBindingService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool[] {
  return [{
    name: 'list_esp32_devices', revision: 'eden.mon.devices.v1', executionMode: 'parallel',
    description: toolDescription('list_esp32_devices'),
    parameters: toJson(z.toJSONSchema(emptyInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      emptyInput.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'device.read', 'owner-esp32-devices', {})
      return mon.listEsp32Devices(sessionId, context.signal)
    },
  }, {
    name: 'control_esp32_device', revision: 'eden.mon.devices.v1', executionMode: 'sequential',
    description: toolDescription('control_esp32_device'),
    parameters: toJson({ ...z.toJSONSchema(commandInput), ...z.toJSONSchema(commandVariant), type: 'object' }) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = commandVariant.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'device.control', `esp32:${input.deviceId}:${input.action}`, toJson(input))
      context.signal.throwIfAborted()
      const ttlSeconds = input.action === 'call.start' ? 30 : 10
      return mon.issueEsp32Command(sessionId, toJson({
        device_id: input.deviceId,
        action: input.action,
        arguments: commandArguments(input),
        request_id: `${turnId}:${context.callId}`,
        ttl_seconds: ttlSeconds,
      }), context.signal)
    },
  }, {
    name: 'get_esp32_command_status', revision: 'eden.mon.devices.v1', executionMode: 'parallel',
    description: toolDescription('get_esp32_command_status'),
    parameters: toJson(z.toJSONSchema(commandIdInput)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = commandIdInput.parse(raw)
      await permissions.request({ ...context, sessionId, turnId }, 'device.read', `esp32-command:${input.commandId}`, {})
      return mon.esp32CommandStatus(sessionId, input.commandId, context.signal)
    },
  }]
}
