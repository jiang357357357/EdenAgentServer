import type { SessionService } from '../../../src/modules/sessions/index.ts'

/** Model fixture loads by stable tool identity. */
export function loadReply(sessions: SessionService, name: string, identity = `builtin:${name}`) {
  const tool = sessions.toolCatalog().find(item => item.name === name)
  if (!tool) throw new Error(`Fixture tool missing: ${name}`)
  return { tool: 'load_tools', input: { tools: [{ id: identity }] } }
}
