import { z } from 'zod'
import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { DesktopService } from './service.ts'
import { desktopSchemas, type DesktopToolName } from './action-schema.ts'
import { desktopToolDescription } from '../../model-prompts/desktop-tools.ts'
import { DesktopError } from './contracts.ts'
import { cuaTools } from './cua-tools.ts'

export function desktopTools(service: DesktopService, permissions: PermissionService, sessionId: string, turnId: string, actor?: string | number): RuntimeTool[] {
  return [...(Object.keys(desktopSchemas) as DesktopToolName[]).map(name => ({
    name, revision: 'eden.desktop.cua.v6', executionMode: 'sequential', description: desktopToolDescription(name),
    parameters: toJson(z.toJSONSchema(desktopSchemas[name], { io: 'input' })) as Record<string, import('@eden/api').JsonValue>,
    resultImages: (result, signal) => service.images(result, signal),
    outcome: result => {
      const status = (result as { status?: string })?.status
      return status === 'unknown' ? 'unknown' : status === 'refused' ? 'failed' : 'completed'
    },
    failureOutcome: error => error && typeof error === 'object' && 'toolOutcome' in error
      ? (error as { toolOutcome: 'failed' | 'cancelled' | 'unknown' }).toolOutcome : 'unknown',
    async execute(raw, context) {
      const input = desktopSchemas[name].parse(raw) as Record<string, unknown>
      const scope = { ...context, sessionId, turnId }
      await service.authorize(permissions, scope, actor)
      try { return await service.execute(name, input, scope, actor) }
      catch (error) {
        // Runtime errors are rendered as text; retain typed diagnostics on the exception and in that view.
        if (error instanceof DesktopError && error.diagnostics && error.toolOutcome !== 'cancelled')
          error.message += `\n${JSON.stringify({ code: error.code, diagnostics: error.diagnostics })}`
        throw error
      }
    },
  } satisfies RuntimeTool)), ...cuaTools(service, permissions, sessionId, turnId, actor)]
}
