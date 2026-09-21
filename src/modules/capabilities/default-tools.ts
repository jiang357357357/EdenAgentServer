import type { RuntimeTool } from '@eden/runtime-pi'

const common = new Set(['request_user_input', 'read_attachment', 'list_skills', 'load_skill', 'unload_skill', 'read_skill_file',
  'list_tools', 'load_tools', 'unload_tools', 'search_memories'])
const chat = new Set(['remember_memory', 'create_reminder', 'list_memos'])
const workspace = new Set(['read_file', 'write_file', 'exec_command'])
const awake = new Set(['write_diary', 'get_self_awake_context', 'set_self_awake_timer', 'create_reminder', 'show_desktop_reminder',
  'list_contact_channels', 'read_recent_conversation', 'read_qq_messages', 'send_qq_message', 'send_external_email',
  'list_esp32_devices', 'control_esp32_device', 'get_esp32_command_status'])
const child = new Set(['send_parent_message', 'read_agent_messages'])

export function defaultTool(tool: RuntimeTool, profile: string, hasWorkspace: boolean): boolean {
  if (tool.source !== 'builtin') return false
  if (common.has(tool.name)) return true
  if (hasWorkspace && workspace.has(tool.name)) return true
  if (profile === 'self_awake') return awake.has(tool.name)
  return profile === 'subagent' ? child.has(tool.name) : chat.has(tool.name)
}
