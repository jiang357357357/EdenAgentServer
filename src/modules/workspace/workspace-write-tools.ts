import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { WorkspaceService } from './workspace-service.ts'
import { writeWorkspaceFile } from './workspace-write.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const pathField = z.string().min(1).max(4096)
const write = z.object({ path: pathField, content: z.string().max(1024 * 1024), createOnly: z.boolean().default(false) }).strict()
const edit = z.object({ path: pathField, oldText: z.string().min(1).max(1024 * 1024),
  newText: z.string().max(1024 * 1024) }).strict()

export function workspaceWriteTools(workspace: WorkspaceService, permissions: PermissionService,
  sessionId: string, turnId: string, scope: string): RuntimeTool[] {
  return [
    { name: 'write_file', revision: 'eden.workspace.write.v1', executionMode: 'sequential',
      description: toolDescription('write_file'),
      parameters: toJson(z.toJSONSchema(write, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) {
        const input = write.parse(raw)
        const expectedSha256 = await workspace.writeSnapshot(scope, input.path)
        return commit({ ...input, expectedSha256, createOnly: input.createOnly || expectedSha256 === null }, context)
      } },
    { name: 'edit_file', revision: 'eden.workspace.edit.v1', executionMode: 'sequential',
      description: toolDescription('edit_file'),
      parameters: toJson(z.toJSONSchema(edit, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(raw, context) {
        const input = edit.parse(raw)
        const current = await workspace.read(input.path)
        if (current.binary || current.truncated || !current.sha256) throw new Error('Edit requires a UTF-8 file of at most 1 MiB')
        const first = current.content.indexOf(input.oldText)
        if (first < 0 || current.content.indexOf(input.oldText, first + input.oldText.length) >= 0)
          throw new Error('oldText must match exactly once; read the current file and narrow the edit')
        const content = current.content.slice(0, first) + input.newText + current.content.slice(first + input.oldText.length)
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Edited file exceeds 1 MiB')
        return commit({ path: input.path, content, expectedSha256: current.sha256, createOnly: false }, context)
      } },
  ]

  async function commit(snapshot: { path: string; content: string; expectedSha256: string | null; createOnly: boolean },
    context: Parameters<RuntimeTool['execute']>[1]) {
    const root = workspace.root()
    await permissions.request({ ...context, sessionId, turnId }, 'workspace.write', root, toJson(snapshot))
    return workspace.mutate(root, context.signal, async () => {
      await writeWorkspaceFile(root, snapshot, context.signal)
      workspace.rememberWrite(scope, snapshot.path, snapshot.content)
      return { path: snapshot.path, bytes: Buffer.byteLength(snapshot.content) }
    })
  }
}
