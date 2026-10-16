import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { WorkspaceService } from './workspace-service.ts'
import { fileVersion, changeFile, readRecovery, restoreFile } from './file-recovery.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const filename = z.string().min(1).max(4096)
const schemas = { delete_file: z.object({ path: filename }).strict(),
  rename_file: z.object({ path: filename, destination: filename }).strict(),
  restore_file: z.object({ recoveryId: z.string().uuid() }).strict() }

export function workspaceFileTools(workspace: WorkspaceService, permissions: PermissionService,
  sessionId: string, turnId: string, scope: string, actorId?: string | number): RuntimeTool[] {
  const owner = JSON.stringify([sessionId, actorId ?? null])
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map(name => ({
    name, revision: 'eden.workspace.files.v1', executionMode: 'sequential', description: toolDescription(name),
    parameters: toJson(z.toJSONSchema(schemas[name], { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = schemas[name].parse(raw), location = workspace.snapshot()
      if ('recoveryId' in input) {
        const saved = await readRecovery(location.root, owner, input.recoveryId)
        await permissions.request({ ...context, sessionId, turnId }, 'workspace.write', location.root,
          toJson({ action: 'restore', recoveryId: input.recoveryId, path: saved.metadata.path, bytes: saved.bytes.length }))
        return workspace.mutate(location.root, context.signal, async () => {
          workspace.assertSnapshot(location)
          return restoreFile(location.root, owner, input.recoveryId, context.signal)
        })
      }
      const current = await fileVersion(location.root, input.path)
      const expected = await workspace.writeSnapshot(scope, input.path)
      if (expected !== current.sha256) throw new Error('文件自读取后发生变化，请重新读取')
      const change = { action: name === 'delete_file' ? 'delete' as const : 'rename' as const,
        path: input.path, ...('destination' in input ? { destination: String(input.destination) } : {}), expectedSha256: current.sha256 }
      await permissions.request({ ...context, sessionId, turnId }, 'workspace.write', location.root, toJson({ ...change, bytes: current.bytes.length }))
      return workspace.mutate(location.root, context.signal, async () => {
        workspace.assertSnapshot(location)
        return changeFile(location.root, owner, change, context.signal)
      })
    },
  }))
}
