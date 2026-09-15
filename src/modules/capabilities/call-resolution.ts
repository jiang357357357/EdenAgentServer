import type { RuntimeTool } from '@eden/runtime-pi'
import type { ToolRegistry } from './tool-registry.ts'

export function resolveToolCall(initial: RuntimeTool, input: Record<string, unknown>, registry: ToolRegistry, visible: Set<string>) {
  let tool = registry.find(initial.identity!), value = input
  if (registry.binding(initial).revision !== registry.binding(tool).revision) throw new Error('Tool changed since this model request; refresh before calling')
  const seen = new Set<string>()
  for (;;) {
    if (!visible.has(tool.identity!)) throw new Error(`Tool is not loaded in this session: ${tool.name}`)
    if (seen.has(tool.identity!) || seen.size >= 8) throw new Error('Invalid tool forwarding chain')
    seen.add(tool.identity!)
    const target = tool.target?.(value)
    if (!target) return { tool, input: value }
    tool = registry.find(target.identity)
    value = target.input
  }
}
