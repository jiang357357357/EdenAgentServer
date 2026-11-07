import { createHash } from 'node:crypto'
import type { RuntimeTool } from '@eden/runtime-pi'

export interface ToolBinding { id: string; name: string; revision: string }
export interface ToolConflict { name: string; identities: string[] }

export class ToolRegistry {
  readonly tools: RuntimeTool[]
  readonly conflicts: ToolConflict[]
  constructor(tools: RuntimeTool[]) {
    const grouped = new Map<string, RuntimeTool[]>()
    for (const tool of tools) grouped.set(tool.name, [...grouped.get(tool.name) ?? [], tool])
    this.conflicts = [...grouped.entries()].flatMap(([name, items]) => items.length > 1 && items.some(item => item.source === 'skill')
      ? [{ name, identities: items.map(item => item.identity ?? `builtin:${item.name}`) }] : [])
    const conflictingSkills = new Set(this.conflicts.flatMap(conflict => conflict.identities.filter(identity => identity.startsWith('skill:'))))
    const names = new Set<string>(), identities = new Set<string>()
    this.tools = tools.filter(tool => !conflictingSkills.has(tool.identity ?? '')).map(tool => {
      const identity = tool.identity ?? `builtin:${tool.name}`
      if (names.has(tool.name) || identities.has(identity)) throw new Error(`Conflicting tool: ${tool.name}`)
      if (tool.parameters.type !== 'object') throw new Error(`Tool "${tool.name}" parameters must have an object root`)
      names.add(tool.name); identities.add(identity)
      return { ...tool, identity, source: tool.source ?? 'builtin', executionMode: tool.executionMode ?? 'sequential' }
    })
  }
  lookup(id: string): RuntimeTool | undefined {
    const name = id === 'read_skill' || id === 'builtin:read_skill' ? 'load_skill' : id
    return this.tools.find(item => item.identity === name || item.name === name)
  }
  find(id: string): RuntimeTool {
    const tool = this.lookup(id)
    if (!tool) throw new Error(`Tool is unavailable or excluded by policy: ${id}`)
    return tool
  }
  binding(tool: RuntimeTool): ToolBinding {
    return { id: tool.identity!, name: tool.name, revision: createHash('sha256')
      .update(JSON.stringify([tool.identity, tool.revision, tool.parameters, tool.description])).digest('hex') }
  }
  matches(binding: ToolBinding): boolean {
    const tool = this.tools.find(item => item.identity === binding.id)
    return Boolean(tool && tool.name === binding.name && this.binding(tool).revision === binding.revision)
  }
}
