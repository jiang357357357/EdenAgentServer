import type { JsonValue } from '@eden/api'

export type CommunicationReceipt = {
  state: 'accepted' | 'failed' | 'unknown' | 'pending'; receipt?: JsonValue; error?: string
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Only builtin communication contracts are receipts; generated text is never evidence. */
export function communicationChannel(name: string, input: Record<string, unknown>): string | undefined {
  if (['send_qq_message', 'send_qq_file', 'send_character_sticker'].includes(name)) return 'qq'
  if (name === 'execute_qq_action' && /^(send_(private|group)_msg|send_msg|send_(private|group)_forward_msg)$/.test(String(input.action))) return 'qq'
  if (name === 'send_external_email') return 'email'
  if (name === 'show_desktop_reminder') return 'app'
  if (name === 'control_esp32_device') return 'device'
  return undefined
}

export function communicationReceipt(channel: string, result: JsonValue): CommunicationReceipt {
  const raw = record(result)
  if (['failed', 'not_configured', 'selection_required', 'rejected', 'expired'].includes(String(raw.status)))
    return { state: 'failed', error: '通信渠道未接受此次通知。' }
  if (channel === 'app') {
    if (typeof raw.id !== 'string') return { state: 'unknown', error: '桌面通知缺少有效标识。' }
    return { state: 'pending', receipt: { id: raw.id } }
  }
  if (channel === 'device') {
    if (typeof raw.id !== 'string') return { state: 'unknown', error: '设备命令缺少有效标识。' }
    if (raw.status === 'succeeded') return { state: 'accepted', receipt: { id: raw.id, status: 'succeeded' } }
    return { state: 'pending', receipt: { id: raw.id } }
  }
  if (raw.status === 'accepted' && typeof raw.requestId === 'string')
    return { state: 'accepted', receipt: { channel, requestId: raw.requestId } }
  const messageId = record(raw.result).message_id
  if (channel === 'qq' && raw.status === 'success' && /^-?\d+$/.test(String(messageId)) && !/^-?0+$/.test(String(messageId)))
    return { state: 'accepted', receipt: { channel, messageId: String(messageId) } }
  return { state: 'unknown', error: '通信结果没有有效的发送回执，请先核对收件记录，禁止自动重发。' }
}
