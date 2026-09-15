import { SUBAGENT_ROLE_TEXT } from '../../model-prompts/subagents.ts'

const roles = [
  { name: 'worker', ...SUBAGENT_ROLE_TEXT.worker, sandboxMode: 'inherit', maxTurns: 64 },
  { name: 'general', ...SUBAGENT_ROLE_TEXT.general, sandboxMode: 'inherit', maxTurns: 64 },
  { name: 'researcher', ...SUBAGENT_ROLE_TEXT.researcher, sandboxMode: 'read-only', maxTurns: 24 },
  { name: 'explore', ...SUBAGENT_ROLE_TEXT.explore, sandboxMode: 'read-only', maxTurns: 64 },
  { name: 'file_locator', ...SUBAGENT_ROLE_TEXT.file_locator, sandboxMode: 'read-only', maxTurns: 32 },
  { name: 'coder', ...SUBAGENT_ROLE_TEXT.coder, sandboxMode: 'workspace-write', maxTurns: 64 },
  { name: 'reviewer', ...SUBAGENT_ROLE_TEXT.reviewer, sandboxMode: 'read-only', maxTurns: 32 },
] as const

export function subagentRoles() { return roles.map(role => ({ ...role })) }
export function subagentRole(name: string) {
  const role = roles.find(item => item.name === name)
  if (!role) throw new Error(`Unknown subagent role: ${name}; select a role from agent.roles`)
  return role
}
