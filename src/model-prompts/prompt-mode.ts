import { z } from 'zod'
import type { JsonValue, PromptMode } from '@eden/api'
import { BUILTIN_PROMPT_MODE_TEMPLATE, BUILTIN_PROMPT_MODE_VERSION,
  PROMPT_MODE_LEADING_LAYOUT, PROMPT_MODE_LEADING_ANCHOR,
  LEGACY_EDEN_PROMPT_MODE_TEMPLATE, LEGACY_EDEN_PROMPT_MODE_VERSION,
  LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE, LEGACY_EDEN_V2_PROMPT_MODE_VERSION } from './prompt-mode-eden.ts'
import {
  BUILTIN_PROMPT_MODE_TEMPLATE as LEGACY_PROMPT_MODE_TEMPLATE,
  BUILTIN_PROMPT_MODE_VERSION as LEGACY_PROMPT_MODE_VERSION,
} from './prompt-mode-v3.ts'

const snapshotTemplates = {
  [BUILTIN_PROMPT_MODE_VERSION]: BUILTIN_PROMPT_MODE_TEMPLATE,
  [LEGACY_EDEN_V2_PROMPT_MODE_VERSION]: LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE,
  [LEGACY_EDEN_PROMPT_MODE_VERSION]: LEGACY_EDEN_PROMPT_MODE_TEMPLATE,
  [LEGACY_PROMPT_MODE_VERSION]: LEGACY_PROMPT_MODE_TEMPLATE,
}

// 仅用于宿主已入队的快照。无版本字段的旧快照仍使用提交时的原文。
const snapshotSchema = z.object({
  enabled: z.boolean(), template: z.string().max(65_536),
  templateVersion: z.enum([BUILTIN_PROMPT_MODE_VERSION, LEGACY_EDEN_V2_PROMPT_MODE_VERSION,
    LEGACY_EDEN_PROMPT_MODE_VERSION, LEGACY_PROMPT_MODE_VERSION]).optional(),
  layoutVersion: z.literal(PROMPT_MODE_LEADING_LAYOUT).optional(),
}).strict().refine(value => !value.enabled || value.template.trim().length > 0, {
  message: '超限模式快照缺少提示词',
}).refine(value => value.templateVersion === undefined ||
  value.template === (value.enabled ? snapshotTemplates[value.templateVersion] : ''), {
  message: '内置超限模式快照与版本不一致',
})
export type PromptModeSnapshot = {
  enabled: boolean; template: string
  templateVersion?: typeof BUILTIN_PROMPT_MODE_VERSION | typeof LEGACY_EDEN_V2_PROMPT_MODE_VERSION
    | typeof LEGACY_EDEN_PROMPT_MODE_VERSION | typeof LEGACY_PROMPT_MODE_VERSION
  layoutVersion?: typeof PROMPT_MODE_LEADING_LAYOUT
}

export function createPromptModeSnapshot(mode: PromptMode): PromptModeSnapshot {
  return mode.enabled
    ? { enabled: true, template: BUILTIN_PROMPT_MODE_TEMPLATE, templateVersion: BUILTIN_PROMPT_MODE_VERSION,
      layoutVersion: PROMPT_MODE_LEADING_LAYOUT }
    : { enabled: false, template: '' }
}

/** Host-owned queued snapshot; not a participant, environment or user message field. */
export function promptModeContent(metadata?: JsonValue) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const mode = snapshotSchema.parse(source.promptMode === undefined ? { enabled: false, template: '' } : source.promptMode)
  const text = mode.enabled ? mode.template : ''
  const leading = text !== '' && mode.layoutVersion === PROMPT_MODE_LEADING_LAYOUT
  return {
    prompt: text, leadingPrompt: leading ? text : '', trailingPrompt: leading ? '' : text,
    systemPromptSuffix: leading ? PROMPT_MODE_LEADING_ANCHOR : '',
    sources: text ? [
      { kind: 'system', title: '超限模式', content: text, placement: leading ? 'leading' : 'trailing' },
      ...(leading ? [{ kind: 'system', title: '角色规则收束', content: PROMPT_MODE_LEADING_ANCHOR, placement: 'leading' }] : []),
    ] : [],
  }
}
