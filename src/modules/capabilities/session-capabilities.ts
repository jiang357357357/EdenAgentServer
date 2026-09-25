import type { EdenDatabase } from '@eden/store'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { SessionRepository } from '../sessions/index.ts'
import type { SkillRepository } from '../skills/index.ts'
import { filterSubagentTools, roleSkillBindings } from '../subagent-execution/index.ts'
import { capabilityHint, toolDirectoryHint } from '../../model-prompts/capabilities.ts'
import { SelectionRepository } from './selection-repository.ts'
import type { CapabilitySelection } from './selection-repository.ts'
import { ToolRegistry } from './tool-registry.ts'
import { searchTools } from './tool-search.ts'
import { defaultTool } from './default-tools.ts'
import { discoveryTools } from './discovery-tools.ts'
import { resolveToolCall } from './call-resolution.ts'
import { selectSkill, skillSelectionCurrent, availableSkillSummaries } from './skill-selection.ts'

export interface CapabilityScope { sessionId: string; owner: string; profile: string; workspaceRoot: string; sourceChannel?: 'app' | 'qq' | 'internal' }

export class SessionCapabilities {
  private readonly selections: SelectionRepository
  constructor(private readonly database: EdenDatabase, events: SessionRepository['events'], private readonly skills: SkillRepository,
    private readonly scopeProvider: () => CapabilityScope, private readonly definitions: () => RuntimeTool[]) {
    this.selections = new SelectionRepository(database, events)
  }

  private get scope() { return this.scopeProvider() }

  registry(): ToolRegistry {
    if (this.scope.sourceChannel === 'qq') return new ToolRegistry([])
    const tools = [...this.definitions(), ...discoveryTools(this)].filter(tool => tool.name !== 'read_skill')
    return new ToolRegistry(filterSubagentTools(this.database, this.scope.sessionId, tools))
  }

  private saved() { return this.selections.list(this.scope.sessionId, this.scope.owner) }
  private save(values: CapabilitySelection[]) { this.selections.save(this.scope.sessionId, this.scope.owner, values) }
  private current(selection: CapabilitySelection, registry: ToolRegistry): boolean {
    if (!selection.enabled) return false
    const scoped = selection.kind === 'skill' || selection.tools.some(tool => tool.id.startsWith('skill:') || ['read_file', 'write_file', 'exec_command'].includes(tool.name))
    if (scoped && selection.contextRoot !== this.scope.workspaceRoot) return false
    return selection.kind === 'skill' ? skillSelectionCurrent(this.skills, selection, this.scope.profile)
      : selection.tools.every(tool => registry.matches(tool))
  }
  private visible(registry: ToolRegistry): Set<string> {
    const visible = new Set(registry.tools.filter(tool => defaultTool(tool, this.scope.profile, Boolean(this.scope.workspaceRoot))).map(tool => tool.identity!))
    for (const selection of this.saved()) if (selection.kind === 'tool' && this.current(selection, registry)) {
      for (const tool of selection.tools) visible.add(tool.id)
    }
    return visible
  }

  tools(): RuntimeTool[] {
    const registry = this.registry()
    this.preload(registry)
    const visible = this.visible(registry)
    const stale = this.saved().some(item => item.enabled && !this.current(item, registry))
    const hint = capabilityHint(availableSkillSummaries(this.skills, registry, this.scope.profile), stale)
    const directory = toolDirectoryHint(registry.tools.filter(tool => !visible.has(tool.identity!)))
    return registry.tools.filter(tool => visible.has(tool.identity!)).map(tool => ({ ...tool, exposure: 'direct',
      ...(tool.name === 'list_skills' ? { promptHint: [hint, tool.promptHint].filter(Boolean).join('\n') } : {}),
      ...(tool.name === 'list_tools' ? { promptHint: [directory, tool.promptHint].filter(Boolean).join('\n') } : {}),
      resolveCall: input => {
        const latest = this.registry()
        const resolved = resolveToolCall(tool, input, latest, this.visible(latest))
        return { ...resolved, tool: { ...resolved.tool, assertCurrent: () => {
          const current = this.registry()
          resolveToolCall(resolved.tool, resolved.input, current, this.visible(current))
        } } }
      },
    }))
  }

  discover(input: { query: string; offset: number; limit: number }) {
    const registry = this.registry(), visible = this.visible(registry)
    const all = searchTools(registry.tools, input.query)
    return { tools: all.slice(input.offset, input.offset + input.limit).map(tool => ({ id: tool.identity!, name: tool.name,
      source: tool.source, description: tool.description.slice(0, 400), loaded: visible.has(tool.identity!), executionMode: tool.executionMode })),
      nextOffset: input.offset + input.limit < all.length ? input.offset + input.limit : null, total: all.length,
      selections: this.saved().map(item => ({ kind: item.kind, key: item.key, enabled: item.enabled,
        status: !item.enabled ? 'unloaded' : this.current(item, registry) ? 'loaded' : 'stale' })) }
  }

  loadTools(requested: { id: string }[]) {
    const registry = this.registry(), loaded: { id: string; name: string }[] = [], failed: { id: string; error: string }[] = []
    for (const id of new Set(requested.map(item => item.id))) {
      try {
        const binding = registry.binding(registry.find(id))
        const selection = this.selections.tool(binding, this.scope.workspaceRoot)
        this.assertLimit([selection])
        this.save([selection])
        loaded.push({ id: binding.id, name: binding.name })
      } catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }) }
    }
    return { loaded, failed }
  }

  unloadTools(ids: string[]) {
    const saved = this.saved().filter(item => item.kind === 'tool' && ids.includes(item.key))
    this.save(saved.map(item => ({ ...item, enabled: false })))
    return { unloaded: saved.map(item => item.key) }
  }

  loadSkill(name: string, expected?: { contentHash: string; workspaceRoot: string }) {
    const registry = this.registry()
    const selection = selectSkill(this.skills, registry, name, this.scope.profile)
    if (expected && (selection.revision !== expected.contentHash || selection.workspaceRoot !== expected.workspaceRoot)) throw new Error('Skill snapshot changed; reload its instructions')
    selection.contextRoot = this.scope.workspaceRoot
    this.assertLimit([selection])
    this.save([selection])
    return { name, tools: selection.tools.map(tool => ({ id: tool.id, name: tool.name, loaded: this.visible(registry).has(tool.id) })),
      missingTools: this.skills.read(name, false).tools.filter(dependency => !registry.lookup(dependency)) }
  }

  unloadSkill(name: string) {
    const previous = this.saved().find(item => item.kind === 'skill' && item.key === name)
    if (previous) this.save([{ ...previous, enabled: false }])
    return { name, unloaded: Boolean(previous) }
  }

  private assertLimit(incoming: CapabilitySelection[]) {
    const keys = new Set(incoming.map(item => `${item.kind}:${item.key}`))
    const next = [...this.saved().filter(item => !keys.has(`${item.kind}:${item.key}`)), ...incoming]
    for (const kind of ['skill', 'tool'] as const) {
      if (next.filter(item => item.enabled && item.kind === kind).length > 96) throw new Error(`Unload unused ${kind} selections before loading more`)
    }
  }

  private preload(registry: ToolRegistry) {
    if (this.scope.profile !== 'subagent') return
    const saved = this.saved()
    for (const binding of roleSkillBindings(this.database, this.scope.sessionId)) {
      if (saved.some(item => item.kind === 'skill' && item.key === binding.name)) continue
      let selection: CapabilitySelection
      try { selection = selectSkill(this.skills, registry, binding.name, this.scope.profile) }
      catch { selection = { kind: 'skill', key: binding.name, revision: binding.contentHash, workspaceRoot: binding.workspaceRoot,
        contextRoot: this.scope.workspaceRoot, tools: [], enabled: true } }
      if (selection.revision !== binding.contentHash || selection.workspaceRoot !== binding.workspaceRoot) {
        selection = { ...selection, revision: binding.contentHash, workspaceRoot: binding.workspaceRoot, tools: [] }
      }
      selection.contextRoot = this.scope.workspaceRoot
      this.assertLimit([selection])
      this.save([selection])
    }
  }
}
