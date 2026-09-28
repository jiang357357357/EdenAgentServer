import type { SessionEvent } from '@eden/api'
import { displayText } from './screen-text.ts'

type Presented = { label: string; text: string; key?: string; complete?: boolean; time?: number }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function contentText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') return displayText(message.content)
  if (!Array.isArray(message.content)) return ''
  return message.content.map(part => {
    const value = record(part)
    return value?.type === 'text' && typeof value.text === 'string' ? displayText(value.text) : ''
  }).join('')
}

export function presentEvent(event: SessionEvent, history = false, tools?: Map<string, { name: string; args: string }>): Presented | undefined {
  const payload = record(event.payload)
  if (event.eventType === 'agent.message_start' || event.eventType === 'agent.message_update' || event.eventType === 'agent.message_end') {
    const message = record(payload?.message)
    if (!message || message.display === false || message.internalHandoff === true) return undefined
    if (message.role !== 'assistant' && message.role !== 'user') return undefined
    if (message.role === 'user' && event.eventType !== 'agent.message_end') return undefined
    const text = contentText(message)
    if (!text && event.eventType !== 'agent.message_start') return undefined
    const speaker = record(message.speaker)
    const name = typeof speaker?.assistantName === 'string' ? speaker.assistantName : '智能体'
    const messageId = typeof payload?.messageId === 'string' ? payload.messageId : event.id
    return { label: message.role === 'user' ? '你' : displayText(name), text: text || '…',
      key: `message:${messageId}`, complete: event.eventType === 'agent.message_end', time: event.createdAt }
  }
  if (history) return undefined
  if (event.eventType === 'operation.started') {
    const name = String(payload?.name ?? '工具')
    const key = `tool:${event.turnId}:${String(payload?.callId ?? event.id)}`
    const args = payload?.args === undefined ? '' : `\n${displayText(JSON.stringify(payload.args)).slice(0, 400)}`
    tools?.set(key, { name, args })
    return { key, label: '工具', text: `${name} · 执行中${args}`, complete: false, time: event.createdAt }
  }
  if (event.eventType === 'operation.completed') {
    const key = `tool:${event.turnId}:${String(payload?.callId ?? event.id)}`
    const tool = tools?.get(key) ?? { name: '工具', args: '' }
    tools?.delete(key)
    return { key, label: '工具', text: `${tool.name} · ${payload?.failed === true ? '执行失败' : '执行完成'}${tool.args}`,
      complete: true, time: event.createdAt }
  }
  if (event.eventType === 'turn.started') return { label: '系统', text: '智能体正在处理' }
  if (event.eventType === 'turn.completed') return { label: '系统', text: '本轮完成' }
  if (event.eventType === 'turn.failed' || event.eventType === 'input.interrupted') return {
    label: '错误', text: String(payload?.reason ?? '本轮中断'),
  }
  if (event.eventType === 'permission.requested') return {
    label: '审批', text: `${String(payload?.capability ?? '')} ${String(payload?.resource ?? '')}；输入 /permissions 查看`,
  }
  if (event.eventType === 'question.requested') return { label: '提问', text: '智能体有待回答的问题；输入 /questions 查看' }
  return undefined
}
