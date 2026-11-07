import { cuaToolNames, type JsonValue } from '@eden/api'
import { businessContent, resultObject, type ModelResult } from './model-fields.ts'
import { agentResult, mailboxResult } from './agent-results.ts'
import { assistantListResult, deviceCommandResult, deviceListResult, emailResult, handoffResult } from './contact-results.ts'
import { connectorEventResult, connectorListResult, connectorPackageResult, createdSkillResult,
  mcpServersResult, mcpBusinessResult, pluginManagementResult, skillExecutionResult } from './extension-results.ts'
import { attachmentResult, conversationResult, diaryResult, memoResult, memoryResult, reminderResult, selfAwakeResult, timerResult } from './personal-results.ts'
import { fileResult, imageResult, sharedQueryResult } from './shared-results.ts'
import { qqModelResult } from './qq-result-privacy.ts'
import { stickerResult } from './sticker-results.ts'
import { videoResult } from './video-results.ts'
import { desktopResult } from './desktop-results.ts'

/** These tools already construct business-only results. Their bodies remain opaque. */
const businessTools = new Set(['manage_ui_plugins', 'manage_plugin_packages', 'manage_plugin_grants', 'manage_connector_instances', 'build_connector_plugin', 'request_user_input', 'list_tools', 'load_tools', 'unload_tools',
  'list_skills', 'read_skill', 'load_skill', 'unload_skill', 'read_skill_file',
  'list_directory', 'search_files', 'exec_command', 'web_search', 'web_fetch', 'web_find',
  'analyze_screen', 'capture_camera', 'browser_inspect', 'list_contact_channels',
  'desktop_list_windows', 'desktop_observe', 'desktop_read_text', 'desktop_click', 'desktop_type', 'desktop_key',
  'desktop_scroll', 'desktop_drag', 'desktop_window', 'desktop_launch',
  'query_connector', 'execute_connector', 'list_mcp_capabilities', 'call_mcp_tool', 'read_mcp_resource'])
for (const name of cuaToolNames) businessTools.add(`cua_${name}`)

const projections: Record<string, ModelResult> = {
  inspect_video: videoResult, prepare_video: videoResult, read_video_timeline: videoResult,
  get_video_frames: videoResult, get_video_frame_previews: videoResult, delete_video_job: videoResult, video_context_doctor: videoResult,
  list_character_stickers: stickerResult, remember_character_sticker: stickerResult,
  send_character_sticker: stickerResult, delete_character_sticker: stickerResult,
  read_file: fileResult, write_file: fileResult, edit_file: fileResult, delete_file: fileResult,
  read_image: imageResult,
  rename_file: fileResult, restore_file: fileResult,
  read_attachment: attachmentResult,
  remember_memory: memoryResult, search_memories: memoryResult, update_memory: memoryResult, forget_memory: memoryResult,
  create_memo: memoResult, create_reminder: memoResult, list_memos: memoResult, list_memos_page: memoResult, list_due_memos: memoResult,
  update_memo: memoResult, complete_memo: memoResult, archive_memo: memoResult, snooze_memo: memoResult, get_next_memo_wake: memoResult,
  show_desktop_reminder: reminderResult, get_desktop_reminder: reminderResult,
  set_self_awake_timer: timerResult, write_diary: diaryResult, get_self_awake_context: selfAwakeResult,
  send_external_email: emailResult, read_recent_conversation: conversationResult,
  list_esp32_devices: deviceListResult, control_esp32_device: deviceCommandResult, get_esp32_command_status: deviceCommandResult,
  list_assistants: assistantListResult, switch_assistant: handoffResult,
  spawn_agent: agentResult, list_agents: agentResult, wait_agent: agentResult, followup_task: agentResult,
  interrupt_agent: agentResult, send_message: agentResult, send_parent_message: mailboxResult, read_agent_messages: mailboxResult,
  create_skill: createdSkillResult, run_skill_tool: skillExecutionResult, manage_plugins: pluginManagementResult,
  manage_connector_plugins: connectorPackageResult, list_connectors: connectorListResult, read_connector_events: connectorEventResult,
  list_mcp_servers: mcpServersResult,
  list_mcp_capabilities: mcpBusinessResult, call_mcp_tool: mcpBusinessResult, read_mcp_resource: mcpBusinessResult,
  query_shared_workspace: sharedQueryResult, read_shared_file: fileResult, write_shared_file: fileResult,
  edit_shared_file: fileResult, delete_shared_file: fileResult, rename_shared_file: fileResult, restore_shared_file: fileResult,
  list_qq_capabilities: qqModelResult, list_qq_events: qqModelResult, read_qq_action: qqModelResult,
  execute_qq_action: qqModelResult, send_qq_message: qqModelResult, send_qq_file: qqModelResult, read_qq_messages: qqModelResult,
}
for (const name of [...cuaToolNames.map(name => `cua_${name}`), 'desktop_list_windows', 'desktop_observe', 'desktop_read_text',
  'desktop_click', 'desktop_type', 'desktop_key', 'desktop_scroll', 'desktop_drag', 'desktop_window', 'desktop_launch'])
  projections[name] = (value, input) => desktopResult(name, value, input)

export function toolModelResult(name: string, source?: string): ModelResult | undefined {
  if (source === 'skill') return skillExecutionResult
  if (source === 'mcp') return mcpBusinessResult
  if (source === 'plugin') return businessContent
  return Object.hasOwn(projections, name) ? projections[name] : businessTools.has(name) ? businessContent : undefined
}

/** Historical dynamic skill tools used the same host envelope as run_skill_tool. */
function historicalSkillEnvelope(name: string, result: JsonValue) {
  return result !== null && typeof result === 'object' && !Array.isArray(result) && result.tool === name
    && typeof result.skill === 'string' && typeof result.revision === 'string' && Object.hasOwn(result, 'output')
}

export function historicalModelResult(name: string, result: JsonValue, source?: string): ModelResult | undefined {
  if (source === 'skill') return skillExecutionResult
  if (source === 'mcp') return mcpBusinessResult
  if (source === 'plugin') return businessContent
  const known = toolModelResult(name.startsWith('eden_') ? name.slice(5) : name)
  if (known) return known
  // Retired App delivery has no registered tool; retain decoding of existing audit/checkpoint receipts only.
  if (name === 'send_app_message' || name === 'eden_send_app_message') return businessContent
  if (source === 'builtin' || name.startsWith('eden_')) throw new Error(`历史宿主工具尚未登记模型结果契约：${name}`)
  if (name.startsWith('mcp__')) return mcpBusinessResult
  if (name.startsWith('plugin_')) return businessContent
  if (historicalSkillEnvelope(name, result)) return skillExecutionResult
  return undefined
}

export function projectRecordedResult(name: string, result: JsonValue, input?: Record<string, unknown>, hidden?: Set<string>, source?: string): JsonValue {
  const project = historicalModelResult(name, result, source)
  if (!project) return result
  if (result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 1 && typeof result.error === 'string')
    return { error: resultObject(result).error! }
  return project(result, input, hidden)
}
