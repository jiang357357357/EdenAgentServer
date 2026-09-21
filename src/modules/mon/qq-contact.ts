import { ContactNotDeliveredError } from './contact-error.ts'
import { z } from 'zod'
import type { MonClient } from '@eden/integrations'
import type { EdenDatabase } from '@eden/store'
import { emailContactSchema } from './email-contact.ts'
import { deliverContact } from './contact-delivery.ts'
const scalar = z.union([z.string(), z.number().int().safe()]).transform(String)
const target = z.object({ target_type: z.string().optional(), target_qq_number: scalar.optional(), qq_number: scalar.optional(), id: scalar.optional() }).passthrough()
export async function ownerQqTarget(client: MonClient, signal: AbortSignal) {
  const raw = await client.get('/api/devices/qq_bot/management/', signal)
  const outer = z.record(z.string(), z.unknown()).parse(raw)
  const data = z.object({ bot_id: scalar.nullish(), default_bot_id: scalar.nullish(), default_send_target: target.nullish(),
    permissions: z.object({ allowed_contacts: z.array(target.extend({ approved: z.boolean().optional(), permission_level: z.string().optional() })).max(10000).optional() }).optional(),
  }).parse(outer.data ?? raw)
  const configuredBot = data.bot_id ?? data.default_bot_id
  if (!configuredBot) throw new Error('当前账号尚未配置 QQ 机器人，暂时无法读取或发送 QQ 消息')
  const bot = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).parse(configuredBot)
  const selected = data.default_send_target?.target_qq_number ? data.default_send_target
    : data.permissions?.allowed_contacts?.find(item => item.approved === true && item.permission_level === 'super_admin')
  if (!selected || (selected.target_type ?? 'user') !== 'user') throw new Error('当前账号尚未配置老师的私人 QQ 接收目标')
  const number = z.string().regex(/^\d{5,20}$/).parse(selected.target_qq_number ?? selected.qq_number ?? selected.id)
  return { bot, number }
}
export async function deliverOwnerQq(database: EdenDatabase, client: MonClient, sessionId: string, raw: unknown, signal: AbortSignal) {
  const input = emailContactSchema.extend({ title: z.string().trim().max(256).default('') }).parse(raw)
  let selected
  try { selected = await ownerQqTarget(client, signal) } catch { signal.throwIfAborted(); throw new ContactNotDeliveredError('QQ target could not be resolved; no message was sent') }
  const body = JSON.stringify({ target_type: 'user', target_qq_number: selected.number, content: input.title ? `${input.title}\n\n${input.message}` : input.message,
    metadata: { source: 'contact_user', source_type: 'self_awake', source_id: input.requestId }, request_id: input.requestId })
  return deliverContact(database, client, sessionId, input.requestId, 'qq', `/api/devices/qq_bot/${selected.bot}/send-message/`, body, signal)
}
