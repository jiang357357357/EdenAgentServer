import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { CommandService } from '../commands/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import { WorkspaceService } from './workspace-service.ts'
import { workspaceReadTools } from './workspace-read-tools.ts'
import { workspaceWriteTools } from './workspace-write-tools.ts'
import { workspaceFileTools } from './workspace-file-tools.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { terminalToolContext } from '../../model-prompts/terminal.ts'

const commandSchema = z.object({ command: z.string().min(1).max(65536),
  timeoutSeconds: z.number().int().min(1).max(600).default(30) }).strict()

export function workspaceTools(workspace: WorkspaceService, permissions: PermissionService, sessionId: string, turnId: string, commands: CommandService, _workspaceOnly = false, actorId?: string | number): RuntimeTool[] {
  const scope = JSON.stringify([sessionId, turnId, actorId ?? null])
  const terminal = sessionId === '00000000-0000-4000-8000-000000000000' ? null : commands.snapshot(sessionId).terminal
  return [
    ...workspaceReadTools(workspace, scope),
    ...workspaceWriteTools(workspace, permissions, sessionId, turnId, scope),
    ...workspaceFileTools(workspace, permissions, sessionId, turnId, scope, actorId),
    {
      name: 'exec_command', revision: 'eden.workspace.exec.v3', executionMode: 'sequential',
      description: `${toolDescription('exec_command')}\n${terminalToolContext(terminal)}`,
      outcome: result => result && typeof result === 'object' && !Array.isArray(result) && result.exitCode === 0 ? 'completed' : 'failed',
      parameters: toJson(z.toJSONSchema(commandSchema, { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
      async execute(input, context) {
        const params = commandSchema.parse(input)
        const location = workspace.snapshot(true), root = location.root
        const snapshot = commands.snapshot(sessionId)
        await permissions.request({ ...context, sessionId, turnId }, 'command.execute', root, toJson({ ...params, execution: snapshot }))
        return workspace.mutateCommand(root, context.signal, async () => toJson(await commands.execute(snapshot, root, params.command,
          context.signal, params.timeoutSeconds * 1000)), location)
      }
    },
  ]
}
