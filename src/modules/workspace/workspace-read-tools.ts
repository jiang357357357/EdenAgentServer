import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { WorkspaceService } from './workspace-service.ts'
import { searchWorkspace } from './workspace-search.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const read = z.object({ path: z.string().min(1).max(4096), offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(4).max(262144).optional() }).strict()
const list = z.object({ path: z.string().max(4096).default('.'), offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100) }).strict()
const search = z.object({ query: z.string().min(1).max(200), path: z.string().max(4096).default('.'),
  limit: z.number().int().min(1).max(50).default(20) }).strict()

export function workspaceReadTools(workspace: WorkspaceService, scope: string): RuntimeTool[] {
  return [
    { name: 'read_file', revision: 'eden.workspace.read.v2', description: toolDescription('read_file'),
      parameters: toJson(z.toJSONSchema(read, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) {
        const input = read.parse(raw)
        context.signal.throwIfAborted()
        const result = await workspace.readForModel(scope, input.path, input.offset, input.limit)
        context.signal.throwIfAborted()
        return toJson(result)
      } },
    { name: 'list_directory', revision: 'eden.workspace.list.v1', description: toolDescription('list_directory'),
      parameters: toJson(z.toJSONSchema(list, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) {
        const input = list.parse(raw)
        context.signal.throwIfAborted()
        const directory = await workspace.list(input.path)
        const entries = directory.entries.slice(input.offset, input.offset + input.limit)
        return toJson({ path: directory.path, entries,
          nextOffset: input.offset + input.limit < directory.entries.length ? input.offset + input.limit : null })
      } },
    { name: 'search_files', revision: 'eden.workspace.search.v1', description: toolDescription('search_files'),
      parameters: toJson(z.toJSONSchema(search, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) {
        const input = search.parse(raw)
        return toJson(await searchWorkspace(workspace.root(), input.path, input.query, input.limit, context.signal))
      } },
  ]
}
