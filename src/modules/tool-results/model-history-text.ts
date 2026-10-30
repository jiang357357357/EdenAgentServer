import { mapJsonText } from '@eden/api'
import type { JsonTextProjector } from '@eden/api'
import { mapHistoryContent } from '@eden/runtime-pi'
import { projectActorTurnContent } from '../../model-prompts/actors.ts'
import { projectSelfAwakeHistory } from '../../model-prompts/self-awake.ts'

/** Known host wrappers fail closed on malformed JSON; ordinary prose may contain JSON fragments. */
export const mapModelHistoryText: JsonTextProjector = (text, visit, prose) => {
  let matched = false
  const project = (value: Parameters<typeof visit>[0]) => { matched = true; return visit(value) }
  const imported = mapHistoryContent(text, project)
  if (matched) return imported
  const actor = projectActorTurnContent(text, project)
  if (matched) return actor
  const awake = projectSelfAwakeHistory(text, project)
  return matched ? awake : mapJsonText(text, visit, prose)
}
