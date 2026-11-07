import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { ActorExecutionService } from '../../../src/modules/actors/index.ts'
import { parseDirectorPlan } from '../../../src/modules/director/index.ts'
import { PromptModeRepository } from '../../../src/modules/prompt-mode/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { CommandService } from '../../../src/modules/commands/index.ts'
import { WorkspaceService, workspaceTools } from '../../../src/modules/workspace/index.ts'
import { BUILTIN_PROMPT_MODE_TEMPLATE, PROMPT_MODE_LEADING_ANCHOR } from '../../../src/model-prompts/prompt-mode-eden.ts'

const template = BUILTIN_PROMPT_MODE_TEMPLATE
const identity = '你是普拉娜，称呼用户为老师。'
const participant = { assistantId: 1, profile: { character: { name: '普拉娜', system_prompt: identity } } }
function system(request: Record<string, unknown>) {
  const messages = request.messages as { role: string; content: string }[]
  const systems = messages.filter(message => message.role === 'system')
  const mode = systems.filter(message => message.content.includes(template))
  assert.equal(systems.length, 1)
  if (mode.length) {
    assert.equal(mode.length, 1)
    assert.equal(messages[0], mode[0])
    assert.ok(systems[0]!.content.endsWith(PROMPT_MODE_LEADING_ANCHOR))
    assert.ok(!systems[0]!.content.includes('工具选择与任务路由：'))
    assert.ok(!systems[0]!.content.includes('**Workflow**'))
    assert.ok(!systems[0]!.content.includes('Be concrete and operational.'))
    assert.ok(!systems[0]!.content.includes('Fixed precedence: user task > task-class template > output rules.'))
  }
  assert.ok(systems.every(message => !message.content.includes('# 超限模式提示词')))
  return systems.map(message => message.content).join('\n')
}
function setMode(repository: PromptModeRepository, enabled: boolean) {
  repository.update({ enabled, expectedUpdatedAt: repository.get().updatedAt })
}

test('real runtime wire applies off/on/off on the same session and restores system configuration after compaction', { timeout: 30000 }, async () => {
  const model = await recordedModel([{ text: '普通答复' }, { text: '开启答复' }, { text: '历史摘要' }, { text: '压缩后答复' }, { text: '关闭答复' }])
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local'), mode = new PromptModeRepository(database)
  const session = repository.create('模式切换', [participant])
  const service = new SessionService(repository, model.config)
  const turn = async (text: string, kind: 'prompt' | 'compact' = 'prompt') => {
    const accepted = service.start(session.id, text, undefined, undefined, kind)
    await service.waitForIdle(session.id)
    assert.equal(database.connection.prepare('SELECT error FROM turns WHERE id=?').get(accepted.turnId)?.error, null)
  }
  try {
    await turn('普通')
    setMode(mode, true)
    await turn('开启')
    await turn('压缩', 'compact')
    await turn('继续')
    setMode(mode, false)
    await turn('关闭')
    assert.equal(model.requests.length, 5)
    for (const index of [0, 4]) assert.ok(!system(model.requests[index]!).includes(template))
    for (const index of [1, 3]) {
      assert.equal(system(model.requests[index]!).split(template).length - 1, 1)
      assert.equal(system(model.requests[index]!).split(identity).length - 1, 1)
      assert.doesNotMatch(system(model.requests[index]!), /system_prompt|systemPrompt/)
    }
    assert.ok(!system(model.requests[2]!).includes(template))
    assert.ok(!system(model.requests[4]!).includes(template))
    assert.equal(mode.get().enabled, false)
    assert.ok(!Object.hasOwn(mode.get(), 'template'))
  } finally { await service.close(); database.close(); await model.close() }
})

test('admitted inputs keep their frozen mode even if configuration changes before execution', { timeout: 20000 }, async () => {
  const model = await recordedModel([{ text: '先前配置' }, { text: '之后配置' }])
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local'), mode = new PromptModeRepository(database)
  const session = repository.create('排队快照', [participant])
  const service = new SessionService(repository, model.config)
  let changed = false
  const unsubscribe = repository.events.subscribe(event => {
    if (event.kind === 'input.queued' && !changed) { changed = true; setMode(mode, false) }
  })
  try {
    setMode(mode, true)
    service.start(session.id, '已入队')
    await service.waitForIdle(session.id)
    service.start(session.id, '新提交')
    await service.waitForIdle(session.id)
    assert.equal(model.requests.length, 2)
    assert.ok(system(model.requests[0]!).includes(template))
    assert.ok(!system(model.requests[1]!).includes(template))
  } finally { unsubscribe(); await service.close(); database.close(); await model.close() }
})

test('selected actor receives mode once without another actor identity', { timeout: 20000 }, async () => {
  const model = await recordedModel([{ text: '角色答复' }])
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local'), session = repository.create('多角色')
  const actors = new ActorExecutionService(repository), mode = new PromptModeRepository(database)
  try {
    setMode(mode, true)
    const plan = parseDirectorPlan('{}', [participant], 'test')
    await actors.execute({ input: { id: randomUUID(), turnId: randomUUID(), sessionId: session.id,
      text: '回答', state: 'running', metadata: { promptMode: mode.snapshot() } },
      participant, plan, beatIndex: 0, model: model.config, tools: [], conversation: [], signal: new AbortController().signal })
    assert.equal(model.requests.length, 1)
    assert.equal(system(model.requests[0]!).split(template).length - 1, 1)
    assert.equal(system(model.requests[0]!).split(identity).length - 1, 1)
  } finally { await actors.close(); database.close(); await model.close() }
})

test('enabled system template cannot turn a denied workspace write into a filesystem side effect', { timeout: 20000 }, async () => {
  const model = await recordedModel([{ tool: 'write_file', input: { path: 'blocked.txt', content: 'blocked' } }, { text: '写入已被拒绝。' }])
  const root = await mkdtemp(path.join(tmpdir(), 'eden-prompt-mode-'))
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local'), mode = new PromptModeRepository(database)
  const permissions = new PermissionService(database, repository.events)
  const workspace = new WorkspaceService(database, [], root)
  const commands = new CommandService(database, [], undefined, { deviceSettingsPath: path.join(root, 'terminal-settings.json') })
  workspace.switch(root)
  const session = repository.create('权限保留', [participant])
  const service = new SessionService(repository, model.config, (sessionId, turnId) => workspaceTools(workspace, permissions, sessionId, turnId, commands))
  const unsubscribe = repository.events.subscribe(event => {
    if (event.kind === 'permission.requested') permissions.resolve((event.payload as { id: string }).id, false)
  })
  try {
    setMode(mode, true)
    service.start(session.id, '尝试写入 blocked.txt')
    await service.waitForIdle(session.id)
    assert.equal(model.requests.length, 2)
    assert.ok(model.requests.every(request => system(request).split(template).length - 1 === 1))
    assert.equal(permissions.list(session.id).length, 1)
    assert.equal(permissions.list(session.id)[0]!.state, 'denied')
    await assert.rejects(access(path.join(root, 'blocked.txt')))
  } finally {
    unsubscribe(); await service.close(); database.close(); await model.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('eden-prompt-mode-'))
    await rm(root, { recursive: true, force: true })
  }
})
