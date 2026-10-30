import { z } from 'zod'
import type { JsonValue } from '@eden/api'
import type { MonClient } from '@eden/integrations'

const botsSchema = z.object({ data: z.array(z.object({
  id: z.union([z.string(), z.number().int().safe()]).transform(String), status: z.string(),
})).max(10000) })

/** A connected BotCore bridge alone does not establish the selected QQ account's status. */
export async function qqBotOnline(client: MonClient, bot: string, bridge: boolean | undefined, signal: AbortSignal): Promise<boolean | null> {
  if (bridge !== true) return bridge === false ? false : null
  try {
    const raw = await client.get('/api/devices/qq_bot/?summary=true', signal)
    const selected = botsSchema.parse(raw).data.find(item => item.id === bot)
    if (selected?.status === 'online') return true
    return selected && ['offline', 'error'].includes(selected.status) ? false : null
  } catch {
    signal.throwIfAborted()
    return null
  }
}

export function qqChannelReadiness(result: PromiseSettledResult<{ online: boolean | null }>): JsonValue {
  if (result.status === 'rejected') return { available: false, configured: false, online: null,
    availabilityMeaning: 'online_owner_target', readiness: 'unavailable', message: 'QQ 目标配置或连接状态读取失败，请检查当前 Core 连接', replyTool: 'read_qq_messages' }
  const online = result.value.online
  return { available: online === true, configured: true, online, availabilityMeaning: 'online_owner_target',
    readiness: online === true ? 'ready' : online === false ? 'offline' : 'unknown',
    message: online === true ? '已配置接收目标，BotCore 已连接且当前 QQBot 在线；实际投递仍以发送回执为准'
      : online === false ? 'QQBot 未在线，当前不能发送消息' : '尚未取得机器人在线状态，当前不能确认可发送', replyTool: 'read_qq_messages' }
}
