import type { SkillSnapshot } from '../../skills/index.ts'

type Skill = { pluginId: string; snapshot: SkillSnapshot }

/** Preview only compares enabled plugin contributions; other scopes are checked when building the catalog. */
export function packageSkillWarnings(pluginId: string, candidate: readonly Skill[], active: readonly Skill[]): string[] {
  const warnings: string[] = []
  const known = [...active.filter(item => item.pluginId !== pluginId)]
  for (const item of candidate) {
    for (const other of known) {
      if (other.snapshot.name === item.snapshot.name)
        warnings.push(`技能 ${item.snapshot.name} 与插件 ${other.pluginId} 的技能同名，不能同时启用。`)
      for (const tool of item.snapshot.codeTools ?? []) if (other.snapshot.codeTools?.some(value => value.name === tool.name))
        warnings.push(`技能工具 ${tool.name} 与插件 ${other.pluginId} 的技能 ${other.snapshot.name} 同名，冲突工具不会注册。`)
    }
    known.push(item)
  }
  return [...new Set(warnings)]
}
