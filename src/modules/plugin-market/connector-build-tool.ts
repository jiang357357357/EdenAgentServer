import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { WorkspaceService } from '../workspace/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import { toolDescription } from '../../model-prompts/tool-descriptions.ts'
import { connectorBuildPaths, buildConnectorPackage } from './connector-builder.ts'

const request = z.object({ source: z.string().min(1).max(4096), output: z.string().min(1).max(4096) }).strict()
export function connectorBuildTool(workspace: WorkspaceService, permissions: PermissionService, sessionId: string, turnId: string): RuntimeTool {
  return { name: 'build_connector_plugin', revision: 'eden.connector-build.v1', executionMode: 'sequential',
    description: toolDescription('build_connector_plugin'), parameters: toJson(z.toJSONSchema(request)) as Record<string, import('@eden/api').JsonValue>,
    async execute(raw, context) {
      const input = request.parse(raw), snapshot = workspace.snapshot(), paths = connectorBuildPaths(workspace, input.source, input.output)
      await permissions.request({ ...context, sessionId, turnId }, 'plugin.connector.build', paths.target, toJson({ source: paths.sourceRoot, output: paths.target }))
      context.signal.throwIfAborted()
      return workspace.mutate(snapshot.root, context.signal, async () => {
        workspace.assertSnapshot(snapshot)
        const current = connectorBuildPaths(workspace, input.source, input.output)
        if (current.target !== paths.target || current.sourceRoot !== paths.sourceRoot) throw new Error('构建路径在审批期间发生变化')
        return toJson(await buildConnectorPackage(current.sourceRoot, current.target, context.signal))
      })
    },
  }
}
