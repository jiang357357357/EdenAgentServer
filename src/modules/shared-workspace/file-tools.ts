import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { SharedWorkspaceService } from './service.ts'
import { SharedLibraryFiles } from './file-access.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const filename = z.string().min(1).max(4096)
const read = z.object({ path: filename, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(4).max(262144).default(65536) }).strict()
const write = z.object({ path: filename, content: z.string().max(1024 * 1024), createOnly: z.boolean().default(false) }).strict()
const edit = z.object({ path: filename, oldText: z.string().min(1).max(1024 * 1024), newText: z.string().max(1024 * 1024) }).strict()
const fileOperations = { delete_shared_file: z.object({ path: filename }).strict(),
  rename_shared_file: z.object({ path: filename, destination: filename }).strict(),
  restore_shared_file: z.object({ recoveryId: z.string().uuid() }).strict() }

export function sharedLibraryFileTools(service: SharedWorkspaceService, permissions: PermissionService,
  sessionId: string, turnId: string, actorId?: string | number): RuntimeTool[] {
  const files = new SharedLibraryFiles(service, permissions, sessionId, turnId, JSON.stringify([sessionId, turnId, actorId ?? null]), JSON.stringify([sessionId, actorId ?? null]))
  return [
    ...(Object.keys(fileOperations) as (keyof typeof fileOperations)[]).map(name => ({
      name, revision: 'eden.shared-library.files.v1', executionMode: 'sequential' as const, description: toolDescription(name),
      parameters: toJson(z.toJSONSchema(fileOperations[name], { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw: Record<string, unknown>, context: Parameters<RuntimeTool['execute']>[1]) {
        const input = fileOperations[name].parse(raw)
        return 'recoveryId' in input ? files.restore(input.recoveryId, context)
          : files.change({ ...input, action: name === 'delete_shared_file' ? 'delete' : 'rename' }, context)
      },
    })),
    { name: 'read_shared_file', revision: 'eden.shared-library.read.v1', description: toolDescription('read_shared_file'),
      parameters: toJson(z.toJSONSchema(read, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) { const input = read.parse(raw); return files.read(input.path, input.offset, input.limit, context.signal) } },
    { name: 'write_shared_file', revision: 'eden.shared-library.write.v1', executionMode: 'sequential', description: toolDescription('write_shared_file'),
      parameters: toJson(z.toJSONSchema(write, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) { const input = write.parse(raw); return files.write(input.path, input.content, input.createOnly, context) } },
    { name: 'edit_shared_file', revision: 'eden.shared-library.edit.v1', executionMode: 'sequential', description: toolDescription('edit_shared_file'),
      parameters: toJson(z.toJSONSchema(edit, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) { const input = edit.parse(raw); return files.edit(input.path, input.oldText, input.newText, context) } },
  ]
}
