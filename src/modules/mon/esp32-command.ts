import { MonHttpError } from '@eden/integrations'
import type { MonClient } from '@eden/integrations'
import { toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'

const identityActions = new Set(['call.start', 'message.send', 'notification.show'])

function commandWithAssistant(raw: JsonValue, resolveAssistantId: () => string | number | undefined): JsonValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  if (typeof raw.action !== 'string' || !identityActions.has(raw.action)) return raw
  const assistantId = Number(resolveAssistantId())
  if (!Number.isSafeInteger(assistantId) || assistantId <= 0) {
    throw new Error('当前 Agent 会话没有可用于 ESP 联系设备的 Core 助手身份')
  }
  const argumentsValue = raw.arguments && typeof raw.arguments === 'object' && !Array.isArray(raw.arguments)
    ? raw.arguments : {}
  return toJson({ ...raw, arguments: { ...argumentsValue, assistant_id: assistantId } })
}

export async function issueEsp32Command(client: () => MonClient, raw: JsonValue,
  resolveAssistantId: () => string | number | undefined, signal: AbortSignal) {
  const request = commandWithAssistant(raw, resolveAssistantId)
  try {
    return await client().post('/api/agent/devices/esp32/commands/', request, signal)
  } catch (error) {
    if (!(error instanceof MonHttpError)) throw error
    if (error.status === 404) throw new Error('ESP32 设备不存在或不属于当前用户')
    if (error.status === 409) throw new Error('ESP32 设备当前离线，请先检查设备连接')
    if (error.status === 400) throw new Error('ESP32 拒绝了参数、助手身份不可用或设备尚未声明该控制能力')
    throw error
  }
}
