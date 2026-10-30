import { z } from 'zod'
import type { JsonValue, PromptMode } from '@eden/api'
import { BUILTIN_PROMPT_MODE_TEMPLATE, BUILTIN_PROMPT_MODE_VERSION } from './prompt-mode-v3.ts'

// 仅用于宿主已入队的快照。无版本字段的旧快照仍使用提交时的原文。
const snapshotSchema = z.object({
  enabled: z.boolean(), template: z.string().max(65_536),
  templateVersion: z.literal(BUILTIN_PROMPT_MODE_VERSION).optional(),
}).strict().refine(value => !value.enabled || value.template.trim().length > 0, {
  message: '超限模式快照缺少提示词',
}).refine(value => value.templateVersion === undefined ||
  value.template === (value.enabled ? BUILTIN_PROMPT_MODE_TEMPLATE : ''), {
  message: '内置超限模式快照与版本不一致',
})
export type PromptModeSnapshot = {
  enabled: boolean; template: string; templateVersion?: typeof BUILTIN_PROMPT_MODE_VERSION
}

export function createPromptModeSnapshot(mode: PromptMode): PromptModeSnapshot {
  return mode.enabled
    ? { enabled: true, template: BUILTIN_PROMPT_MODE_TEMPLATE, templateVersion: BUILTIN_PROMPT_MODE_VERSION }
    : { enabled: false, template: '' }
}

/** Host-owned queued snapshot; not a participant, environment or user message field. */
export function promptModeContent(metadata?: JsonValue) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const mode = source.promptMode === undefined ? { enabled: false, template: '' } : snapshotSchema.parse(source.promptMode)
  const text = mode.enabled ? mode.template : ''
  return {
    prompt: text ? `\n\n# 超限模式提示词\n${text}` : '',
    sources: text ? [{ kind: 'system', title: '超限模式', content: text }] : [],
  }
}
