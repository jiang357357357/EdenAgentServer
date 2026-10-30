import type { JsonValue } from '@eden/api'
import { projectActorTurnHistory } from '../../model-prompts/actors.ts'
import { projectSelfAwakeHistory } from '../../model-prompts/self-awake.ts'
import { selfAwakeResult } from './personal-results.ts'
import { resultObject } from './model-fields.ts'

/** Image-bearing SDK user messages use text blocks; their host wrappers need the same projection. */
export function modelUserHistory(content: JsonValue, visit: (value: JsonValue) => JsonValue, hidden?: Set<string>): JsonValue {
  const projectText = (text: string) => {
    const actor = projectActorTurnHistory(text, history => history.map(visit))
    return projectSelfAwakeHistory(actor, value => {
      const context = resultObject(selfAwakeResult(value, undefined, hidden))
      if (Array.isArray(context.recent_conversation)) context.recent_conversation = context.recent_conversation.map(item => {
        const round = resultObject(item)
        if (typeof round.assistantText !== 'string') return round
        const message = resultObject(visit({ role: 'assistant', content: round.assistantText }))
        return { ...round, assistantText: message.content! }
      })
      return context
    })
  }
  if (typeof content === 'string') return projectText(content)
  if (!Array.isArray(content)) return content
  return content.map(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string') return block
    return { ...block, text: projectText(block.text) }
  })
}
