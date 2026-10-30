import { toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { PermissionService } from '../permissions/index.ts'
import type { DesktopService } from './service.ts'
import { cuaCatalog, assertCuaInput } from './cua-catalog.ts'
import { CUA_NATIVE_GUIDANCE } from '../../model-prompts/cua-tools.ts'

const internal = new Set(['snapshot_id', 'snapshotId'])
const sensitive = new Set(['kill_app', 'clipboard_write', 'browser_prepare', 'browser_set_input_files', 'browser_download', 'page',
  'start_recording', 'replay_trajectory', 'install_ffmpeg', 'set_config', 'set_agent_cursor_theme', 'set_agent_cursor_motion'])
export function cuaModelSchema(input: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'properties' && item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([name]) => !internal.has(name)).map(([name, schema]) => [name, walk(schema)]))
        : key === 'required' && Array.isArray(item) ? item.filter(name => !internal.has(String(name))) : walk(item)]))
  }
  return walk(input) as Record<string, unknown>
}
export function cuaTools(service: DesktopService, permissions: PermissionService, sessionId: string, turnId: string,
  actor?: string | number): RuntimeTool[] {
  return cuaCatalog.map(tool => ({ name: `cua_${tool.name}`, revision: 'eden.cua.0.28.0.v2', executionMode: 'sequential',
    description: `${CUA_NATIVE_GUIDANCE}\n\n${tool.description}`, parameters: toJson(cuaModelSchema(tool.inputSchema)) as Record<string, import('@eden/api').JsonValue>,
    resultImages: (result, signal) => service.images(result, signal),
    outcome: result => {
      const status = (result as { status?: string })?.status
      return status === 'unknown' ? 'unknown' : status === 'refused' ? 'failed' : 'completed'
    },
    failureOutcome: error => error && typeof error === 'object' && 'toolOutcome' in error
      ? (error as { toolOutcome: 'failed' | 'cancelled' | 'unknown' }).toolOutcome : 'unknown',
    async execute(input, context) {
      assertCuaInput(tool.name, input)
      const scope = { ...context, sessionId, turnId }
      await service.authorize(permissions, scope, actor)
      if (sensitive.has(tool.name) || ['screenshot_out_file', 'output_dir', 'destination_root', 'file_path', 'image_path'].some(key => input[key] !== undefined))
        await permissions.request(scope, tool.name === 'install_ffmpeg' ? 'command.execute' : `cua.${tool.name}`, `Cua ${tool.name}`, toJson(input))
      scope.signal.throwIfAborted(); scope.assertCurrent?.()
      return service.execute(`cua_${tool.name}`, input, scope, actor)
    },
  }))
}
