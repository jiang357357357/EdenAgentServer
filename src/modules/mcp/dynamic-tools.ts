import type { RuntimeTool } from '@eden/runtime-pi'
import type { McpLifecycle } from './lifecycle.ts'
import { mcpResultImages } from './result-images.ts'
export function dynamicMcpTools(lifecycle: McpLifecycle, dispatcher: RuntimeTool): RuntimeTool[] {
  return lifecycle.catalog.list().flatMap(entry => {
    let runtime: ReturnType<McpLifecycle['get']>
    try { runtime = lifecycle.get(entry.runtimeId, entry.revision) } catch { return [] }
    return [{ identity: `mcp:${entry.runtimeId}:${entry.remote.name}`, source: 'mcp' as const,
      outcome: dispatcher.outcome!, modelResult: dispatcher.modelResult!, name: entry.name, revision: entry.digest, executionMode: 'sequential' as const,
      description: entry.remote.description ?? `MCP 工具 ${entry.remote.name}`,
      parameters: entry.remote.inputSchema, resultImages: mcpResultImages,
      async execute(raw: Record<string, unknown>, context: { callId: string; signal: AbortSignal }) {
        if (!lifecycle.catalog.matches(entry) || lifecycle.get(entry.runtimeId, entry.revision) !== runtime) throw new Error('MCP 工具定义已经变化；刷新工具后再重试')
        return dispatcher.execute({ runtimeId: entry.runtimeId, name: entry.remote.name, arguments: raw }, context)
      } }]
  })
}
