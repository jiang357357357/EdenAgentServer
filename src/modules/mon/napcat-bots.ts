import { z } from 'zod'
import type { NapcatTarget } from './napcat-transport.ts'
import { readNapcatResponse } from './napcat-transport.ts'
import { qqBotNotConfiguredMessage, qqBotSelectionMessage } from '../../model-prompts/qq-targets.ts'

const databaseId = z.union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive().safe()]).transform(String)
const botSchema = z.object({ id: databaseId, bot_id: z.string().min(1).max(128),
  bot_name: z.string().max(200).optional(), qq_nickname: z.string().max(200).optional(),
  status: z.string().max(80), is_default: z.boolean().optional() })
const listSchema = z.object({ success: z.literal(true), data: z.array(botSchema).max(10000) })

export interface QqBotChoice { bot_id: string; bot_qq: string; name: string; status: string; is_default: boolean }
export interface QqBotSelection {
  status: 'selection_required' | 'not_configured'; code: string;
  selection_required: boolean; bots: QqBotChoice[]; message: string;
}

/** Current session's Core token only; never service/owner credentials or a client-side global bot cache. */
export async function listNapcatBots(target: NapcatTarget, signal: AbortSignal, fetcher: typeof fetch): Promise<QqBotChoice[]> {
  if (!target.token || target.identity || target.qqContext) throw new Error('机器人发现仅支持已连接 Core 的 App 会话')
  signal.throwIfAborted()
  const response = await fetcher(new URL('/api/devices/qq_bot/?summary=true', target.baseUrl), {
    method: 'GET', headers: { Authorization: `Token ${target.token}`, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`QQ 机器人列表读取失败（HTTP ${response.status}），请检查当前账号的 Core 连接与权限`)
  }
  const parsed = listSchema.parse(await readNapcatResponse(response))
  signal.throwIfAborted()
  const ids = new Set<string>()
  return parsed.data.map(bot => {
    if (ids.has(bot.id)) throw new Error('Core 返回了重复的机器人记录，请重新查询')
    ids.add(bot.id)
    return { bot_id: bot.id, bot_qq: bot.bot_id, name: bot.bot_name || bot.qq_nickname || bot.bot_id,
      status: bot.status, is_default: bot.is_default === true }
  })
}

export function qqBotSelection(bots: QqBotChoice[]): QqBotSelection {
  return { status: bots.length ? 'selection_required' : 'not_configured',
    code: bots.length ? 'QQ_BOT_SELECTION_REQUIRED' : 'QQ_BOT_NOT_CONFIGURED',
    selection_required: bots.length > 0, bots,
    message: bots.length ? qqBotSelectionMessage : qqBotNotConfiguredMessage }
}
