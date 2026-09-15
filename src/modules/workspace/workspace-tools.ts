import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { CommandService } from '../commands/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import { WorkspaceService } from './workspace-service.ts'
import { writeWorkspaceFile } from './workspace-write.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'

const readSchema = z.object({ path: z.string().min(1).max(4096) }).strict()
const writeSchema = readSchema.extend({ content: z.string().max(1024 * 1024), createOnly: z.boolean().default(false) })
const commandSchema = z.object({ command: z.string().min(1).max(65536) }).strict()

export function workspaceTools(workspace: WorkspaceService, permissions: PermissionService, sessionId: string, turnId: string, commands: CommandService, _workspaceOnly = false, actorId?: string | number): RuntimeTool[] {
  const scope = JSON.stringify([sessionId, turnId, actorId ?? null])
  return [
    {
      name: 'read_file', revision: 'eden.workspace.read.v1', description: toolDescription('read_file'),
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async execute(input, context) { context.signal.throwIfAborted(); return toJson(await workspace.readForModel(scope, readSchema.parse(input).path)) }
    },
    {
      name: 'write_file', revision: 'eden.workspace.write.v1', executionMode: 'sequential',
      description: toolDescription('write_file'),
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false },
      async execute(input, context) {
        const params = writeSchema.parse(input)
        const root = workspace.root()
        const expectedSha256 = await workspace.writeSnapshot(scope, params.path)
        const snapshot = { ...params, expectedSha256, createOnly: params.createOnly || expectedSha256 === null }
        await permissions.request({ ...context, sessionId, turnId }, 'workspace.write', root, toJson(snapshot))
        return workspace.mutate(root, context.signal, async () => {
          await writeWorkspaceFile(root, snapshot, context.signal)
          workspace.rememberWrite(scope, params.path, params.content)
          return { path: params.path, bytes: Buffer.byteLength(params.content) }
        })
      }
    },
    {
      name: 'exec_command', revision: 'eden.workspace.exec.v1', executionMode: 'sequential',
      description: toolDescription('exec_command'),
      outcome: result => result && typeof result === 'object' && !Array.isArray(result) && result.exitCode === 0 ? 'completed' : 'failed',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
      async execute(input, context) {
        const params = commandSchema.parse(input)
        const root = workspace.commandRoot()
        const snapshot = commands.snapshot()
        await permissions.request({ ...context, sessionId, turnId }, 'command.execute', root, toJson({ ...params, execution: snapshot }))
        return workspace.mutateCommand(root, context.signal, async () => toJson(await commands.execute(snapshot, root, params.command, context.signal)))
      }
    },
  ]
}
