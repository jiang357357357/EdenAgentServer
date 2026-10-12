import type { SessionEvent } from '@eden/api'
import { displayText } from './screen-text.ts'
import { presentTool, type ToolHistory } from './tool-view.ts'

type Presented = { label: string; text: string; key?: string; complete?: boolean; time?: number; failed?: boolean }

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

function messageEvent(event: SessionEvent, payload: Record<string, unknown> | undefined): Presented | undefined {
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

export function presentEvent(event: SessionEvent, history = false, tools?: ToolHistory): Presented | undefined {
  const payload = record(event.payload)
  if (['agent.message_start', 'agent.message_update', 'agent.message_end'].includes(event.eventType)) return messageEvent(event, payload)
  if (history) return undefined
  if (event.eventType.startsWith('operation.')) return presentTool(event, payload, tools)
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
