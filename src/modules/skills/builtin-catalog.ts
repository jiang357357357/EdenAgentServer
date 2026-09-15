import { BUILTIN_SKILL_GUIDES } from '../../model-prompts/builtin-skills.ts'
import { snapshot } from './snapshot.ts'

// Bundled as TypeScript data so development and standalone builds use identical guides.
const snapshots = BUILTIN_SKILL_GUIDES.map(guide => {
  const content = `---\nname: ${guide.name}\ndescription: ${JSON.stringify(guide.description)}\nmetadata:\n  edenagent:\n    tools: ${JSON.stringify(guide.tools)}\n    profiles: ${JSON.stringify(guide.profiles)}\n---\n${guide.content}\n`
  return snapshot({ 'SKILL.md': Buffer.from(content).toString('base64') }, guide.name)
})

export function builtinSkillSnapshots() { return snapshots }
