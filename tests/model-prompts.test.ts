import assert from 'node:assert/strict'
import test from 'node:test'
import type { DirectorPlan } from '@eden/api'
import { ACTOR_SYSTEM_RULES, actorTurnInstruction } from '../src/model-prompts/actors.ts'
import { connectorEventContext } from '../src/model-prompts/connectors.ts'
import { DIRECTOR_SYSTEM_PROMPT } from '../src/model-prompts/director.ts'
import { HANDOFF_CONTEXT_INSTRUCTION } from '../src/model-prompts/handoff.ts'
import { dueMemoInstruction, memoRedeliveryInstruction } from '../src/model-prompts/jobs.ts'
import { MEMORY_EXTRACTION_PROMPT, MEMORY_RECALL_HEADING } from '../src/model-prompts/memory.ts'
import { connectorPluginGuide } from '../src/model-prompts/plugin-development.ts'
import { pluginHookInstruction } from '../src/model-prompts/plugin-hooks.ts'
import { selfAwakeInstruction, SELF_AWAKE_INTERPRETATIONS, SELF_AWAKE_RECOVERY_INSTRUCTION } from '../src/model-prompts/self-awake.ts'
import { SESSION_SYSTEM_RULES } from '../src/model-prompts/session.ts'
import { skillCatalogHint } from '../src/model-prompts/skills.ts'
import { SUBAGENT_ROLE_TEXT, subagentTaskInstruction } from '../src/model-prompts/subagents.ts'
import { connectorCapabilityDescription, mediaCaptureDescription, memoryToolDescription, memoToolDescription, toolDescription } from '../src/model-prompts/tool-descriptions.ts'

const toolNames = [
  'read_attachment', 'list_connectors', 'read_connector_events', 'list_assistants', 'switch_assistant',
  'list_mcp_servers', 'list_mcp_capabilities', 'call_mcp_tool', 'read_mcp_resource', 'list_contact_channels',
  'read_qq_messages', 'send_external_email', 'list_esp32_devices', 'control_esp32_device', 'get_esp32_command_status', 'show_desktop_reminder', 'get_desktop_reminder', 'manage_connector_plugins', 'manage_plugins',
  'request_user_input', 'set_self_awake_timer', 'get_self_awake_context', 'list_skills', 'read_skill', 'load_skill',
  'read_skill_file', 'run_skill_tool', 'create_skill', 'spawn_agent', 'send_parent_message', 'read_agent_messages',
  'list_agents', 'wait_agent', 'send_message', 'followup_task', 'interrupt_agent', 'read_file', 'write_file', 'exec_command',
] as const

test('host-owned model prose is centralized and Chinese', () => {
  const plan: DirectorPlan = { planID: 'plan-1', source: 'model', scene: { domain: 'general', interactionType: 'conversation', confidence: 1, summary: '测试' }, execution: { mode: 'solo', leadAssistantID: '1', observationStrategy: 'none' }, beats: [{ assistantID: '1', intent: '回应', speechAct: 'respond', addressTo: 'user' }] }
  const guide = connectorPluginGuide()
  const values = [
    SESSION_SYSTEM_RULES, ACTOR_SYSTEM_RULES, actorTurnInstruction('你好', plan, 0, []), DIRECTOR_SYSTEM_PROMPT,
    MEMORY_EXTRACTION_PROMPT, MEMORY_RECALL_HEADING, HANDOFF_CONTEXT_INSTRUCTION, dueMemoInstruction({ title: '标题', content: '内容' }),
    memoRedeliveryInstruction({ title: '标题' }), connectorEventContext('event-1'), pluginHookInstruction({ pluginId: 'p', revision: '1', hookId: 'h', eventId: 'e', event: 'changed', occurredAt: 1, skillName: 's', skillContent: '说明' }),
    selfAwakeInstruction({ reason: '测试' }), ...Object.values(SELF_AWAKE_INTERPRETATIONS), SELF_AWAKE_RECOVERY_INSTRUCTION,
    skillCatalogHint([], false), ...Object.values(SUBAGENT_ROLE_TEXT).flatMap(role => [role.description, role.instructions]),
    subagentTaskInstruction({ role: 'worker', instructions: '完成任务。', skillInstructions: '', message: '开始。' }),
    ...toolNames.map(toolDescription), connectorCapabilityDescription('query'), connectorCapabilityDescription('execute'),
    mediaCaptureDescription('screen'), mediaCaptureDescription('camera'), memoryToolDescription('search_memories'), memoToolDescription('list_memos'),
    ...Object.values(guide),
  ]
  for (const value of values) {
    assert.match(value, /[\u3400-\u9fff]/u)
    assert.doesNotMatch(value, /\b(?:You are|Use provided tools|Summarize the conversation|Return strict JSON)\b/u)
    assert.doesNotMatch(value, /不能|不要|不得|禁止|不允许|只允许|必须|不授予|不执行|不保存|不加|不把/u)
  }
})
