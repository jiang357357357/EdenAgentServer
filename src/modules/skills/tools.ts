import { z } from 'zod'
import { skillNameSchema, skillCreateSchema, jsonValue, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { SkillService } from './service.ts'
import type { PermissionService } from '../permissions/index.ts'
import { skillAvailability, supportsSkillProfile } from './availability.ts'
import { directSkillTools } from './direct-tools.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { CAPABILITY_DESCRIPTIONS } from '../../model-prompts/capabilities.ts'
import { skillCatalogFailure, skillCatalogHint } from '../../model-prompts/skills.ts'
const skillReadSchema = z.object({ name: skillNameSchema }).strict()
const skillFileSchema = skillReadSchema.extend({ path: z.string().min(1).max(1024) })

function modelSkill(skill: ReturnType<SkillService['repository']['read']>) {
  return { name: skill.name, description: skill.description, content: skill.content, tools: skill.tools, files: skill.files, available: skill.available, missingTools: skill.missingTools }
}

interface SkillSelection {
  load(name: string, expected: { contentHash: string; workspaceRoot: string }): unknown
  unload(name: string): unknown
}

export function skillTools(service: SkillService, permissions: PermissionService, sessionId: string, turnId: string, profile = 'user_chat', availableTools?: () => readonly string[], selection?: SkillSelection): RuntimeTool[] {
  const availability = (skill: ReturnType<SkillService['repository']['read']>) => {
    if (!availableTools) return skill
    const names = availableTools()
    return skillAvailability(skill, { tools: names, codeToolsAvailable: service.codeToolsAvailable && names.includes('run_skill_tool') })
  }
  const read = (input: z.infer<typeof skillReadSchema>) => {
    const skill = service.repository.read(input.name, true)
    if (!skill.enabled || !skill.modelInvocable) throw new Error('该技能当前不可由模型调用')
    if (!supportsSkillProfile(skill.profiles, profile)) throw new Error('该技能不适用于当前会话场景')
    return { ...skill, ...availability(skill) }
  }
  const definitions = [
    { name: 'list_skills', description: toolDescription('list_skills'), schema: z.object({}).strict(),
      run: () => service.repository.list().filter(skill => skill.enabled && skill.modelInvocable && supportsSkillProfile(skill.profiles, profile))
        .map(skill => {
          const { available, missingTools } = availability(skill)
          return { name: skill.name, description: skill.description, available, missingTools }
        }) },
    { name: 'read_skill', description: toolDescription('read_skill'), schema: skillReadSchema,
      run: (raw: unknown) => modelSkill(read(skillReadSchema.parse(raw))) },
    { name: 'load_skill', description: toolDescription('load_skill'), schema: skillReadSchema,
      run: (raw: unknown) => {
        const skill = read(skillReadSchema.parse(raw))
        const loaded = selection?.load(skill.name, skill)
        return { ...modelSkill(skill), ...(loaded ? { loaded } : {}) }
      } },
    { name: 'unload_skill', description: CAPABILITY_DESCRIPTIONS.unload_skill, schema: skillReadSchema,
      run: (raw: unknown) => { const { name } = skillReadSchema.parse(raw); return selection?.unload(name) ?? { name, unloaded: false } } },
    { name: 'read_skill_file', description: toolDescription('read_skill_file'), schema: skillFileSchema,
      run: (raw: unknown) => {
        const input = skillFileSchema.parse(raw), skill = read(input)
        const file = service.repository.file(input.name, input.path, { expectedContentHash: skill.contentHash, expectedWorkspaceRoot: skill.workspaceRoot })
        return { name: file.name, path: file.path, encoding: file.encoding, content: file.content }
      } },
  ]
  const executeSchema = skillReadSchema.extend({ tool: z.string().min(2).max(64), arguments: jsonValue })
  const inventory = service.repository.list(false).filter(skill => skill.enabled && skill.modelInvocable && supportsSkillProfile(skill.profiles, profile))
    .slice(0, 96).map(skill => ({ name: skill.name, description: skill.description.slice(0, 240) }))
  const promptHint = skillCatalogHint(inventory, Boolean(service.catalogError))
  const tools: RuntimeTool[] = [...definitions.map(definition => ({ name: definition.name, revision: 'eden.skills.v1', executionMode: 'sequential' as const,
    description: definition.description, ...(definition.name === 'list_skills' ? { promptHint: selection ? skillCatalogFailure(Boolean(service.catalogError)) : promptHint } : {}), parameters: toJson(z.toJSONSchema(definition.schema)) as Record<string, JsonValue>,
    async execute(raw: unknown) { definition.schema.parse(raw); return toJson(definition.run(raw)) } })), {
    name: 'run_skill_tool', revision: 'eden.skills.v1', executionMode: 'sequential',
    description: toolDescription('run_skill_tool'),
    parameters: toJson(z.toJSONSchema(executeSchema)) as Record<string, JsonValue>,
    target(raw) {
      const input = executeSchema.parse(raw)
      read(input)
      if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new Error('Skill tool arguments must be an object')
      return { identity: `skill:${input.name}:${input.tool}`, input: input.arguments }
    },
    async execute(raw, context) {
      const input = executeSchema.parse(raw), metadata = read(input)
      const data = service.repository.executionSnapshot(input.name)
      const tool = data.codeTools?.find(item => item.name === input.tool)
      if (!tool) throw new Error('找不到该技能代码工具；请重新发现当前可用工具')
      await permissions.request({ ...context, sessionId, turnId }, 'skill.execute', `${input.name}:${input.tool}`,
        toJson({ revision: data.contentHash, workspaceRoot: metadata.workspaceRoot, command: tool.command, arguments: input.arguments, declaredPermissions: data.permissions }))
      context.signal.throwIfAborted()
      service.repository.read(input.name, false, { expectedContentHash: data.contentHash, expectedWorkspaceRoot: metadata.workspaceRoot })
      const current = read(input)
      if (current.contentHash !== data.contentHash || current.workspaceRoot !== metadata.workspaceRoot) throw new Error('技能在审批后发生变化，请重新提交')
      return service.execute(data, tool, input.arguments, context.signal)
    },
  }, {
    name: 'create_skill', revision: 'eden.skills.v1', executionMode: 'sequential',
    description: toolDescription('create_skill'),
    parameters: toJson(z.toJSONSchema(skillCreateSchema)) as Record<string, JsonValue>,
    async execute(raw, context) {
      const input = skillCreateSchema.parse(raw)
      const preview = service.prepareCreate(input)
      try {
        await permissions.request({ ...context, sessionId, turnId }, 'skill.write', input.name,
          toJson({ ...input, previewId: preview.previewID, contentHash: preview.contentHash, scope: preview.scope, expiresAt: preview.expiresAt }))
        context.signal.throwIfAborted()
        return toJson(service.repository.install(preview.previewID))
      } finally { service.repository.discardPreview(preview.previewID) }
    },
  }]
  return [...tools, ...directSkillTools(service, tools.find(tool => tool.name === 'run_skill_tool')!, profile)]
}
