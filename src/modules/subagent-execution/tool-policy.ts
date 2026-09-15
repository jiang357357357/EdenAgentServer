import { z } from 'zod'
import type { EdenDatabase } from '@eden/store'
import type { RuntimeTool } from '@eden/runtime-pi'
import { subagentRole } from './role-catalog.ts'
import { subagentRoleDefinitionSchema } from '@eden/api'
import type { SubagentRoleDefinition } from '@eden/api'
import { assertSubagentWorkspace } from './workspace-owner.ts'

const policySchema = z.object({
  sandboxMode: z.enum(['inherit', 'read-only', 'workspace-write']),
  allowedTools: z.array(z.string().refine(value => !value.startsWith('eden_'), 'Retired tool name')).nullable(),
  deniedTools: z.array(z.string().refine(value => !value.startsWith('eden_'), 'Retired tool name')), instructions: z.string()
}).strict()
export type SubagentPolicy = z.infer<typeof policySchema>
const rootOnly = ['remember_memory', 'update_memory', 'forget_memory', 'switch_workspace', 'switch_assistant',
  'switch_character_action', 'list_character_stickers', 'remember_character_sticker', 'send_character_sticker', 'delete_character_sticker',
  'send_external_email', 'list_esp32_devices', 'control_esp32_device', 'get_esp32_command_status']
const readOnly = ['list_tools', 'load_tools', 'unload_tools', 'unload_skill', 'read_file', 'read_attachment', 'list_skills', 'read_skill', 'load_skill', 'read_skill_file', 'search_memories',
  'list_memos', 'list_due_memos', 'get_next_memo_wake', 'get_self_awake_context', 'list_connectors', 'query_connector',
  'read_connector_events', 'list_contact_channels', 'read_qq_messages', 'analyze_screen',
  'spawn_agent', 'send_message', 'send_parent_message', 'followup_task', 'interrupt_agent', 'list_agents', 'wait_agent', 'read_agent_messages']

export function rolePolicy(role: string, definition: SubagentRoleDefinition = subagentRoleDefinitionSchema.parse(subagentRole(role))): SubagentPolicy {
  const allowed = definition.sandboxMode === 'read-only' ? readOnly.filter(name => definition.allowedTools === null || definition.allowedTools.includes(name)) : definition.allowedTools
  return {
    sandboxMode: definition.sandboxMode, allowedTools: allowed,
    deniedTools: [...new Set([...rootOnly, ...definition.deniedTools])], instructions: definition.instructions
  }
}
export function narrowPolicy(parent: SubagentPolicy, child: SubagentPolicy): SubagentPolicy {
  parent = policySchema.parse(parent)
  child = policySchema.parse(child)
  const allowed = parent.allowedTools === null ? child.allowedTools : child.allowedTools === null ? parent.allowedTools : child.allowedTools.filter(name => parent.allowedTools!.includes(name))
  const sandboxMode = parent.sandboxMode === 'read-only' || child.sandboxMode === 'read-only' ? 'read-only' :
    parent.sandboxMode === 'workspace-write' || child.sandboxMode === 'workspace-write' ? 'workspace-write' : 'inherit'
  return { sandboxMode, allowedTools: allowed, deniedTools: [...new Set([...parent.deniedTools, ...child.deniedTools])], instructions: child.instructions }
}
export function subagentPolicy(database: EdenDatabase, sessionId: string): SubagentPolicy | undefined {
  let row = database.connection.prepare('SELECT * FROM subagent_threads WHERE child_session_id=?').get(sessionId)
  let policy: SubagentPolicy | undefined
  const seen = new Set<string>()
  while (row) {
    const id = String(row.id)
    if (seen.has(id) || seen.size >= 4) throw new Error('Invalid subagent policy ancestry')
    seen.add(id)
    assertSubagentWorkspace(database, String(row.child_session_id))
    const legacy = database.connection.prepare('SELECT state FROM legacy_subagent_context WHERE agent_id=?').get(id)
    if (legacy && legacy.state !== 'ready') throw new Error('Historical subagent policy requires recovery')
    const saved = database.connection.prepare('SELECT policy_json FROM subagent_policies WHERE agent_id=?').get(id)
    const current = saved ? policySchema.parse(JSON.parse(String(saved.policy_json))) : rolePolicy(String(row.role))
    policy = policy ? narrowPolicy(current, policy) : policySchema.parse(current)
    if (row.parent_id == null) break
    row = database.connection.prepare('SELECT * FROM subagent_threads WHERE id=?').get(row.parent_id)
    if (!row) throw new Error('Subagent policy ancestor is missing')
  }
  return policy
}
const discovery = new Set(['list_tools', 'load_tools', 'unload_tools', 'unload_skill'])

function permits(policy: SubagentPolicy, name: string): boolean {
  const aliases = name === 'load_skill' ? ['load_skill', 'read_skill'] : [name]
  if (rootOnly.includes(name) || aliases.some(alias => policy.deniedTools.includes(alias))) return false
  return discovery.has(name) || policy.allowedTools === null || aliases.some(alias => policy.allowedTools!.includes(alias))
}

export function assertSubagentTool(database: EdenDatabase, sessionId: string, name: string): void {
  const policy = subagentPolicy(database, sessionId)
  if (policy && !permits(policy, name)) throw new Error(`Tool is excluded by the subagent policy: ${name}`)
}
export function filterSubagentTools(database: EdenDatabase, sessionId: string, tools: RuntimeTool[]): RuntimeTool[] {
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Conflicting runtime tool name: ${tool.name}`)
    names.add(tool.name)
  }
  const policy = subagentPolicy(database, sessionId)
  if (!policy) return tools
  return tools.filter(tool => permits(policy, tool.name))
}
