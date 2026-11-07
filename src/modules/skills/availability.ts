import type { SkillSnapshot } from './snapshot.ts'

export interface SkillCapabilities { tools: readonly string[]; codeToolsAvailable: boolean; identities?: readonly string[];
  conflicts?: readonly { name: string; identities: string[] }[] }

export function skillAvailability(skill: Pick<SkillSnapshot, 'name' | 'tools' | 'codeTools'>, capabilities: SkillCapabilities) {
  const known = new Set(capabilities.tools)
  const identities = capabilities.identities ? new Set(capabilities.identities) : undefined
  const missingTools = skill.tools.filter(name => !known.has(name) || Boolean(identities && skill.codeTools?.some(tool => tool.name === name)
    && !identities.has(`skill:${skill.name}:${name}`)))
  const toolConflicts = (capabilities.conflicts ?? []).filter(conflict => conflict.identities.some(identity => identity.startsWith(`skill:${skill.name}:`)))
  return { available: missingTools.length === 0, missingTools, toolConflicts }
}

export function supportsSkillProfile(profiles: readonly string[], profile: string) {
  return (profiles.length ? profiles : ['user_chat', 'self_awake']).includes(profile)
}
