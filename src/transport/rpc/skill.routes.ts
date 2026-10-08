import { rpcMethods } from '@eden/api'
import { contractHandler } from './contract-handler.ts'
import { z } from 'zod'
import { skillReadSchema, skillEnableSchema, skillPreviewInstallSchema, skillFileSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { SkillService } from '../../modules/skills/index.ts'
import type { WorkspaceService } from '../../modules/workspace/index.ts'
export function skillRoutes(service: SkillService, workspace?: WorkspaceService): Record<string, (params: JsonValue) => JsonValue | Promise<JsonValue>> {
  const scoped = (raw: JsonValue) => {
    const value = raw as Record<string, JsonValue>, { sessionId, ...params } = value
    if (!workspace) return { service, params }
    const selected = typeof sessionId === 'string'
      ? service.forWorkspace(() => workspace.forSession(sessionId).availableRoot(), sessionId)
      : service.forWorkspace(() => '', 'account-global')
    return { service: selected, params }
  }
  const handlers: Record<string, (params: JsonValue) => JsonValue | Promise<JsonValue>> = {
    'skill.catalog_status': raw => { z.object({}).strict().parse(raw); return service.status() },
    'skill.refresh': async raw => { z.object({}).strict().parse(raw); await service.refresh(); return { refreshed: true } },
    'skill.list': raw => { z.object({}).strict().parse(raw); return toJson(service.repository.list()) },
    'skill.read': raw => { const input = skillReadSchema.parse(raw); return toJson(service.repository.read(input.name, true, input)) },
    'skill.inspect': async raw => toJson(await service.inspect(raw)),
    'skill.install_preview': raw => toJson(service.repository.install(skillPreviewInstallSchema.parse(raw).previewId)),
    'skill.install': raw => toJson(service.create(raw)),
    'skill.enable': raw => { const input = skillEnableSchema.parse(raw); return toJson(service.repository.enable(input.name, input.enabled, input)) },
    'skill.uninstall': raw => { const input = skillReadSchema.parse(raw); return toJson(service.repository.uninstall(input.name, input)) },
    'skill.file': raw => { const input = skillFileSchema.parse(raw); return toJson(service.repository.file(input.name, input.path, input)) },
  }
  return Object.fromEntries(Object.entries(handlers).map(([method, handler]) => {
    const contract = rpcMethods[method as keyof typeof rpcMethods]
    return [method, contractHandler(contract, input => {
      const selected = scoped(toJson(input))
      if (selected.service !== service) return skillRoutes(selected.service)[method]!(selected.params)
      return handler(selected.params)
    })]
  }))
}
