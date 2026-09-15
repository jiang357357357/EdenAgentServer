import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import type { RuntimeTool } from '@eden/runtime-pi'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { SkillRepository, SkillService, skillTools, createSkillSnapshot, SystemSkillCatalog } from '../../../src/modules/skills/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SessionCapabilities } from '../../../src/modules/capabilities/index.ts'

export async function capabilityFixture(filename = ':memory:', catalog?: SystemSkillCatalog) {
  const database = new EdenDatabase(filename, 'local'), sessions = new SessionRepository(database, 'local')
  const session = sessions.create('Capability fixture'), turnId = randomUUID()
  const permissions = new PermissionService(database, sessions.events)
  permissions.setMode('takeover')
  let workspaceRoot = '', owner = '', profile = 'user_chat', extra: RuntimeTool[] = []
  let raw: () => RuntimeTool[] = () => []
  const skills: SkillRepository = new SkillRepository(database, () => workspaceRoot, undefined, () => ({ tools: raw().map(tool => tool.name), codeToolsAvailable: service.codeToolsAvailable }))
  const service: SkillService = new SkillService(skills, catalog)
  const capabilities = () => new SessionCapabilities(database, sessions.events, skills,
    () => ({ sessionId: session.id, owner, profile, workspaceRoot }), raw)
  raw = () => [...skillTools(service, permissions, session.id, turnId, profile, () => capabilities().registry().tools.map(tool => tool.name), {
    load: (name, expected) => capabilities().loadSkill(name, expected), unload: name => capabilities().unloadSkill(name),
  }), ...extra]
  const install = (name = 'echo-skill', content = '把文本交给 echo_skill，再向用户说明结果。', dependencies: string[] = []) => {
    const files = {
      'SKILL.md': `---\nname: ${name}\ndescription: Echo a message\nmetadata:\n  edenagent:\n    tools: ${JSON.stringify(dependencies)}\n    profiles: [user_chat, subagent, self_awake]\n---\n${content}`,
      'echo.mjs': "let text=''; for await (const part of process.stdin) text+=part; console.log(JSON.stringify({echo:JSON.parse(text).text}))",
      'tools/echo.json': JSON.stringify({ schemaVersion: 1, name: 'echo_skill', description: '回显文本', command: ['node', 'echo.mjs'],
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }),
    }
    const snapshot = createSkillSnapshot(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.from(value).toString('base64')])), name)
    const preview = skills.preview(snapshot, { type: 'generated', uri: '', ref: '', subpath: '' }, 'user')
    return skills.install(preview.previewID)
  }
  await service.start()
  return { database, sessions, session, turnId, permissions, skills, service, capabilities, install,
    exposeEcho() { const scope = capabilities(); scope.loadTools(scope.discover({ query: 'echo_skill', offset: 0, limit: 20 }).tools) },
    setWorkspace(value: string) { workspaceRoot = value }, setOwner(value: string) { owner = value }, setProfile(value: string) { profile = value },
    setTools(value: RuntimeTool[]) { extra = value },
    async close() { await service.close(); database.close() },
  }
}

export function fixtureTool(name = 'special_action'): RuntimeTool {
  return { name, revision: '1', description: '专业动作', parameters: { type: 'object', properties: {} }, async execute() { return { ok: true } } }
}
