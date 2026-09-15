import { z } from 'zod'
import { memoryKindSchema, toJson } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { MemoryRepository } from './repository.ts'
import type { MemoryScopes } from './scope.ts'
import { memoryContent } from './content.ts'
import { memoryToolDescription } from '../../model-prompts/tool-descriptions.ts'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const schemas = {
  remember_memory: z.object({ content: z.string().min(1).max(16000), kind: memoryKindSchema.default('fact') }).strict(),
  search_memories: z.object({ query: z.string().max(1000).default(''), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  update_memory: z.object({ id, content: z.string().min(1).max(16000), kind: memoryKindSchema.optional() }).strict(),
  forget_memory: z.object({ id }).strict(),
}
type Name = keyof typeof schemas
interface Owner { sessionId: string; turnId: string; actorId?: string | number; agentPath?: string }

export function memoryTools(repository: MemoryRepository, scopes: MemoryScopes, permissions: PermissionService, owner: Owner): RuntimeTool[] {
  return (Object.keys(schemas) as Name[]).map(name => ({
    name, revision: 'eden.memory.v1', executionMode: 'sequential',
    description: memoryToolDescription(name),
    parameters: toJson(z.toJSONSchema(schemas[name], { io: 'input' })) as Record<string, JsonValue>,
    async execute(raw, context) {
      context.signal.throwIfAborted()
      const scope = scopes.current(owner.sessionId, owner.turnId, owner.actorId)
      if (name === 'search_memories') {
        const input = schemas.search_memories.parse(raw)
        return toJson(repository.search(scope, input.query, input.limit))
      }
      if (owner.agentPath && owner.agentPath !== '/root') throw new Error('子智能体只能搜索长期记忆')
      const input = schemas[name].parse(raw)
      const content = 'content' in input ? memoryContent(input.content) : undefined
      const previous = 'id' in input ? repository.read(scope, input.id) : undefined
      await permissions.request({ ...context, sessionId: owner.sessionId, turnId: owner.turnId }, 'memory.write',
        `character:${scope.scopeKey}:memory:${previous?.id ?? 'new'}`, toJson({ action: name, scope, input: { ...input, ...(content ? { content } : {}) }, previous: previous ?? null }))
      context.signal.throwIfAborted()
      if (JSON.stringify(scopes.current(owner.sessionId, owner.turnId, owner.actorId)) !== JSON.stringify(scope)) throw new Error('记忆范围在审批期间发生变化，请重新提交')
      if (name === 'remember_memory') {
        const parsed = schemas.remember_memory.parse(input)
        return toJson(repository.create(scope, content!, parsed.kind, owner.sessionId, { source: 'explicit_tool', agentCharacterId: scope.scopeKey }))
      }
      if (name === 'forget_memory') { repository.forget(scope, previous!.id, previous!.updatedAt); return { deleted: true } }
      const parsed = schemas.update_memory.parse(input)
      return toJson(repository.update(scope, previous!.id, previous!.updatedAt, content!, parsed.kind))
    },
  }))
}
