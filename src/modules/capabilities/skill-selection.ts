import { supportsSkillProfile } from '../skills/index.ts'
import type { SkillRepository } from '../skills/index.ts'
import type { CapabilitySelection } from './selection-repository.ts'
import type { ToolRegistry } from './tool-registry.ts'

export function selectSkill(repository: SkillRepository, registry: ToolRegistry, name: string, profile: string): CapabilitySelection {
  const skill = repository.read(name, true)
  if (!skill.enabled || !skill.modelInvocable || !supportsSkillProfile(skill.profiles, profile)) throw new Error(`Skill unavailable in this session: ${name}`)
  const tools = [...new Map(skill.tools.flatMap(dependency => {
    const tool = registry.lookup(skill.codeTools?.some(item => item.name === dependency) ? `skill:${skill.name}:${dependency}` : dependency)
    return tool ? [[tool.identity!, registry.binding(tool)] as const] : []
  })).values()]
  return { kind: 'skill', key: name, revision: skill.contentHash, workspaceRoot: skill.workspaceRoot, contextRoot: '', tools, enabled: true }
}

export function skillSelectionCurrent(repository: SkillRepository, selection: CapabilitySelection, profile: string): boolean {
  try {
    const current = repository.read(selection.key, false)
    return current.enabled && current.modelInvocable && supportsSkillProfile(current.profiles, profile)
      && current.contentHash === selection.revision && current.workspaceRoot === selection.workspaceRoot
  } catch { return false }
}

export function availableSkillSummaries(repository: SkillRepository, registry: ToolRegistry, profile: string) {
  return repository.list(false).flatMap(skill => {
    if (!skill.enabled || !skill.modelInvocable || !supportsSkillProfile(skill.profiles, profile)) return []
    const missingTools = skill.tools.filter(name => skill.codeTools?.some(tool => tool.name === name)
      ? !registry.lookup(`skill:${skill.name}:${name}`) : !registry.lookup(name))
    const toolConflicts = registry.conflicts.filter(conflict => conflict.identities.some(identity => identity.startsWith(`skill:${skill.name}:`)))
    return [{ name: skill.name, description: skill.description.slice(0, 240),
      available: missingTools.length === 0, missingTools, toolConflicts }]
  })
}
