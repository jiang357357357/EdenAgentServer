import type { OperationInfo, SessionEvent } from '@eden/api'
import { displayText } from './screen-text.ts'
import { formatElapsed } from './status-view.ts'

export interface ToolSnapshot { name: string; args: string; startedAt?: number }
export type ToolHistory = Map<string, ToolSnapshot>
type Payload = Record<string, unknown>

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…内容过长，显示已截断` : value
}

function readable(value: unknown): string {
  if (typeof value === 'string') return displayText(value)
  if (!value || typeof value !== 'object') return displayText(JSON.stringify(value) ?? '')
  const record = value as Payload
  if (Array.isArray(record.content)) {
    const blocks = record.content.map(part => {
      if (!part || typeof part !== 'object') return ''
      const block = part as Payload
      return block.type === 'text' ? displayText(block.text) : block.type === 'image' ? '[图片结果]' : ''
    }).filter(Boolean)
    if (blocks.length) return blocks.join('\n')
  }
  const fields = ['stdout', 'stderr', 'text', 'message', 'error'].flatMap(key =>
    typeof record[key] === 'string' && record[key] ? [`${key === 'stdout' || key === 'text' ? '' : `${key}: `}${record[key]}`] : [])
  if (fields.length) return displayText(fields.join('\n'))
  return displayText(JSON.stringify(value, (key, item: unknown) => key === 'data' && typeof item === 'string' && item.length > 1000
    ? `[${item.length} 字符数据]` : item, 2))
}

export function rememberOperation(operation: OperationInfo, tools: ToolHistory): void {
  tools.set(`tool:${operation.turnId}:${operation.toolCallId}`, { name: operation.toolName,
    args: `参数：\n${bounded(readable(operation.request), 4000)}`, startedAt: operation.createdAt })
}

export function presentTool(event: SessionEvent, payload: Payload | undefined, tools?: ToolHistory) {
  const key = `tool:${event.turnId}:${String(payload?.callId ?? event.id)}`
  if (event.eventType === 'operation.started') {
    const name = displayText(payload?.name ?? '工具')
    const args = payload?.args === undefined ? '' : `参数：\n${bounded(readable(payload.args), 4000)}`
    tools?.set(key, { name, args, startedAt: event.createdAt })
    return { key, label: '工具', text: `${name} · 执行中\n${args}`, complete: false, time: event.createdAt, failed: false }
  }
  if (event.eventType !== 'operation.completed') return
  return completedTool(event, payload, tools, key)
}

function completedTool(event: { createdAt: number }, payload: Payload | undefined, tools: ToolHistory | undefined, key: string) {
  const tool = tools?.get(key) ?? { name: '工具', args: '' }
  tools?.delete(key)
  const failed = payload?.failed === true || ['failed', 'unknown', 'cancelled', 'denied'].includes(String(payload?.outcome ?? ''))
  const result = bounded(readable(payload?.result ?? payload?.error ?? ''), 12000)
  const summary = resultSummary(result, payload, failed)
  const duration = tool.startedAt === undefined ? '' : ` · ${formatElapsed(event.createdAt - tool.startedAt)}`
  const state = payload?.outcome === 'unknown' ? '结果未确认' : failed ? '执行失败' : '执行完成'
  return { key, label: '工具', text: `${tool.name} · ${state}${duration}${summary ? ` · ${summary}` : ''}\n${tool.args}\n${failed ? '失败详情' : '结果'}：\n${result || '无文本结果'}`,
    complete: true, time: event.createdAt, failed }
}

/** Recovery uses the public operation snapshot, independent of the message replay cursor. */
export function storedTool(operation: OperationInfo) {
  const tools: ToolHistory = new Map()
  rememberOperation(operation, tools)
  const key = `tool:${operation.turnId}:${operation.toolCallId}`
  if (!['completed', 'failed', 'unknown', 'cancelled', 'denied'].includes(operation.state)) {
    const tool = tools.get(key)!
    return { key, label: '工具', text: `${tool.name} · 处理中 (${operation.state})\n${tool.args}`,
      complete: false, time: operation.createdAt, failed: false }
  }
  const shown = completedTool({ createdAt: operation.updatedAt }, { outcome: operation.state,
    result: operation.result, error: operation.error }, tools, key)
  return { ...shown, time: operation.createdAt }
}

function resultSummary(result: string, payload: Payload | undefined, failed: boolean): string {
  if (!failed) return clipResult(result)
  const detail = payload?.result && typeof payload.result === 'object' && !Array.isArray(payload.result) ? payload.result as Payload : undefined
  return clipResult(readable(detail?.stderr || detail?.error || payload?.error || result))
}

function clipResult(value: string): string {
  const line = value.split('\n').map(line => line.trim()).find(Boolean) ?? ''
  return line.length > 100 ? `${line.slice(0, 100)}…` : line
}
