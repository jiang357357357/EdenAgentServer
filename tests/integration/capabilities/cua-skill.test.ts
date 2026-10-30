import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { cuaToolNames } from '@eden/api'
import { recordedModel } from '@eden/runtime-pi/testing'
import { builtinSkillSnapshots, supportsSkillProfile } from '../../../src/modules/skills/index.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

test('one bundled Cua instruction skill covers the public tools and compatibility interfaces without executable helpers', () => {
  const all = builtinSkillSnapshots().filter(skill => skill.name === 'cua-computer-use')
  assert.equal(all.length, 1)
  const skill = all[0]!
  assert.deepEqual(skill.tools.filter(name => name.startsWith('cua_')).sort(), cuaToolNames.map(name => `cua_${name}`).sort())
  assert.deepEqual(skill.tools.filter(name => name.startsWith('desktop_')).sort(), [
    'desktop_list_windows', 'desktop_observe', 'desktop_read_text', 'desktop_click', 'desktop_type',
    'desktop_key', 'desktop_scroll', 'desktop_drag', 'desktop_window', 'desktop_launch',
  ].sort())
  assert.equal(new Set(skill.tools).size, skill.tools.length)
  assert.deepEqual(Object.keys(skill.files), ['SKILL.md'])
  assert.deepEqual(skill.codeTools, [])
  assert.equal(skill.modelInvocable, true)
  assert.equal(supportsSkillProfile(skill.profiles, 'user_chat'), true)
  assert.equal(supportsSkillProfile(skill.profiles, 'subagent'), true)
  assert.equal(supportsSkillProfile(skill.profiles, 'self_awake'), false)
})

test('real host discovers and reads the Cua skill while expanding only the requested tool schema', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-cua-skill-'))
  const model = await recordedModel([
    { tool: 'list_skills', input: {} },
    { tool: 'load_skill', input: { name: 'cua-computer-use' } },
    { tool: 'load_tools', input: { tools: [{ id: 'builtin:cua_get_window_state' }] } },
    { tool: 'unload_tools', input: { ids: ['builtin:cua_get_window_state'] } },
    { tool: 'unload_skill', input: { name: 'cua-computer-use' } },
    { text: '已读取本机操作技能，仅按需展开窗口观察参数。' },
  ])
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  t.after(async () => {
    try { await server?.close() }
    finally { await model.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }) }
  })
  server = await startServer({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config })
  await server.memoryExtractions.close()
  const session = server.sessions.repository.create('Cua 技能发现和按需说明')
  server.sessions.start(session.id, '读取本机操作技能并了解窗口观察参数，不操作桌面。')
  await server.sessions.waitForIdle(session.id)
  assert.equal(server.sessions.faultCount(), 0)
  assert.equal(model.requests.length, 6)
  const names = model.requests.map(request => (request.tools as { function: { name: string } }[]).map(tool => tool.function.name))
  const cuaSchemas = names.map(tools => tools.filter(name => name.startsWith('cua_')))
  assert.deepEqual(cuaSchemas, [[], [], [], ['cua_get_window_state'], [], []])
  assert.ok(names.every(tools => tools.includes('desktop_list_windows')))
  const result = (index: number) => {
    const messages = model.requests[index]!.messages as { role: string; content: string }[]
    return JSON.parse(messages.filter(message => message.role === 'tool').at(-1)!.content)
  }
  const catalog = result(1) as { name: string; available: boolean; content?: string }[]
  assert.deepEqual(catalog.filter(skill => skill.name === 'cua-computer-use').map(skill => ({ available: skill.available, hasContent: 'content' in skill })),
    [{ available: true, hasContent: false }])
  const loaded = result(2)
  assert.equal(loaded.name, 'cua-computer-use')
  assert.equal(loaded.content, builtinSkillSnapshots().find(skill => skill.name === 'cua-computer-use')!.content)
  assert.deepEqual(loaded.missingTools, [])
  assert.equal(loaded.loaded.tools.filter((tool: { loaded: boolean }) => tool.loaded).length, 1)
  const operations = server.sessions.repository.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY rowid').all(session.id)
  assert.deepEqual(operations.map(row => row.tool_name), ['list_skills', 'load_skill', 'load_tools', 'unload_tools', 'unload_skill'])
  assert.ok(operations.every(row => row.state === 'completed'))
  assert.deepEqual(server.permissions.list(session.id), [])
  const desktopOperations = server.sessions.repository.database.connection.prepare('SELECT COUNT(*) AS count FROM desktop_operations').get()
  assert.equal(desktopOperations?.count, 0)
  t.diagnostic(JSON.stringify({ skill: 'cua-computer-use', associatedTools: loaded.tools.length, cuaSchemas, desktopOperations: 0 }))
})
