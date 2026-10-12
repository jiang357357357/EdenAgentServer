import { cells, clip } from './screen-text.ts'
import type { ScreenState } from './screen-state.ts'
import type { SessionSummary } from '@eden/api'

export function participantLabel(participants: SessionSummary['participants']): string {
  return participants.flatMap(participant => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return []
    const name = participant.assistantName ?? participant.characterName
    return typeof name === 'string' && name.trim() ? [name.trim()] : []
  }).join('、') || '智能体'
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function identityLine(state: ScreenState, width: number): string {
  const world = state.origin === 'mon' ? '伊甸园' : '尘世'
  const remaining = Math.max(0, width - cells(world) - 6)
  const actor = clip(state.agentLabel || '智能体', Math.min(20, Math.floor(remaining / 3)))
  const model = state.modelAvailable === false ? '未选择模型' : state.modelLabel || '模型待确认'
  return clip(`${world} · ${actor} · ${clip(model, Math.max(0, remaining - cells(actor)))}`, width)
}

export function activityLine(state: ScreenState, width: number): string {
  const phase = !state.connected ? state.authStage === 'connecting' ? '正在重连' : '已断开'
    : state.permissions ? `等待审批 ${state.permissions}` : state.questions ? `等待回答 ${state.questions}`
      : state.busy && (!state.turnPhase || state.turnPhase === '就绪') ? '正在处理' : state.turnPhase || '就绪'
  const clock = state.turnElapsedMs === undefined ? '' : ` · 本轮 ${formatElapsed(state.turnElapsedMs)}`
  const context = state.contextTokens == null ? '' : ` · 上下文 ${state.contextTokens.toLocaleString()} tokens`
  const scroll = state.scroll ? ' · ↑ 阅读历史' : ''
  return clip(`${phase}${clock}${scroll}${context}`, width)
}

export function workspaceLine(state: ScreenState, width: number): string {
  const hint = width >= 58 ? 'Ctrl+P 命令 · Ctrl+S 会话' : 'Ctrl+P 命令'
  const location = clip(state.location || '工作区未知', Math.max(0, width - cells(hint) - 2))
  return `${location}${' '.repeat(Math.max(2, width - cells(location) - cells(hint)))}${hint}`
}
