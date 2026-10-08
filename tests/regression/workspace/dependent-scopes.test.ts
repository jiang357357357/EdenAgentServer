import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import type { PluginService } from '@eden/plugin-host'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { CommandService } from '../../../src/modules/commands/index.ts'
import { SkillService, SkillRepository, SystemSkillCatalog, createSkillSnapshot } from '../../../src/modules/skills/index.ts'
import { skillRoutes } from '../../../src/transport/rpc/skill.routes.ts'
import { pluginTools } from '../../../src/modules/plugins/index.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SubagentRepository } from '../../../src/modules/subagents/index.ts'
import { assertSubagentWorkspace } from '../../../src/modules/subagent-execution/index.ts'
import { JobRepository } from '../../../src/modules/jobs/index.ts'
import { createHash } from 'node:crypto'

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-dependent-workspace-')))
  const aRoot = path.join(directory, 'project-a'), bRoot = path.join(directory, 'project-b')
  mkdirSync(aRoot); mkdirSync(bRoot)
  const database = new EdenDatabase(':memory:', 'local'), sessions = new SessionRepository(database, 'local')
  const workspace = new WorkspaceService(database, [], aRoot), a = sessions.create('A'), b = sessions.create('B')
  workspace.forSession(b.id).switch(bRoot)
  const subagents = new SubagentRepository(database, new JobRepository(database), id => id ? workspace.forSession(id).root() : '')
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, aRoot, bRoot, database, sessions, workspace, a, b, subagents }
}

test('per-session terminal changes and active commands do not invalidate another session approvals', async t => {
  const f = fixture(t), controller = new AbortController()
  const commands = new CommandService(f.database, [], undefined, {
    deviceSettingsPath: path.join(f.directory, 'terminal.json'), assertSession: id => { f.sessions.read(id) },
  })
  const approvedA = commands.snapshot(f.a.id)
  const hold = process.platform === 'win32'
    ? "while (-not (Test-Path -LiteralPath 'release')) { Start-Sleep -Milliseconds 20 }; 'done'"
    : 'while [ ! -f release ]; do sleep 0.02; done; echo done'
  const running = commands.execute(approvedA, f.aRoot, hold, controller.signal)
  try {
    await assert.rejects(commands.terminalSet({ scope: 'session', sessionId: f.a.id, target: { kind: 'host' } }), /affected scope/)
    await commands.terminalSet({ scope: 'session', sessionId: f.b.id, target: { kind: 'host' } })
    writeFileSync(path.join(f.aRoot, 'release'), '')
    assert.equal((await running).exitCode, 0)
    assert.equal((await commands.execute(approvedA, f.aRoot, 'echo A-still-valid', controller.signal)).exitCode, 0)
    const approvedB = commands.snapshot(f.b.id)
    await commands.terminalSet({ scope: 'session', sessionId: f.a.id, target: { kind: 'host' } })
    assert.equal((await commands.execute(approvedB, f.bRoot, 'echo B-still-valid', controller.signal)).exitCode, 0)
    await assert.rejects(commands.execute(approvedA, f.aRoot, 'echo stale', controller.signal), /changed after approval/)
  } finally { controller.abort(); await running.catch(() => {}) }
})

test('project skill discovery, previews and failures remain in their originating session', async t => {
  const f = fixture(t), service = new SkillService(new SkillRepository(f.database))
  const writeSkill = (root: string, text: string) => {
    const folder = path.join(root, '.agents', 'skills', 'fixture')
    mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'SKILL.md'), text)
  }
  writeSkill(f.aRoot, '---\nname: fixture\ndescription: A fixture\n---\nA content')
  writeSkill(f.bRoot, '---\nname: fixture\ndescription: B fixture\n---\nB content')
  const a = service.forWorkspace(() => f.workspace.forSession(f.a.id).root(), f.a.id)
  const b = service.forWorkspace(() => f.workspace.forSession(f.b.id).root(), f.b.id)
  try {
    await Promise.all([a.refresh(), b.refresh()])
    assert.match(a.repository.read('fixture').content!, /A content/)
    assert.match(b.repository.read('fixture').content!, /B content/)
    writeSkill(f.aRoot, '---\nmalformed')
    await assert.rejects(a.refresh(), /frontmatter/)
    assert.equal(b.status().error, null)
    assert.match(b.repository.read('fixture').content!, /B content/)
    const snapshot = createSkillSnapshot({ 'SKILL.md': Buffer.from('---\nname: imported\ndescription: imported skill\n---\nInstructions').toString('base64') }, 'imported')
    const preview = a.repository.preview(snapshot, { type: 'generated', uri: '', ref: '', subpath: '' }, 'project')
    assert.throws(() => b.repository.install(preview.previewID), /another session/)
    f.workspace.forSession(f.a.id).switch(f.bRoot); f.workspace.forSession(f.a.id).switch(f.aRoot)
    assert.throws(() => a.repository.install(preview.previewID), /changed after skill preview/)
    assert.equal(service.forWorkspace(() => f.aRoot, f.a.id), a)
    await service.releaseWorkspace(f.a.id)
    assert.notEqual(service.forWorkspace(() => f.aRoot, f.a.id), a)
    assert.match(b.repository.read('fixture').content!, /B content/)
  } finally { await service.close() }
})

test('plugins cannot reuse a different session directory grant or change roots during approval', async t => {
  const f = fixture(t), revision = randomUUID()
  let invoked = 0, beforeApproval: (() => void) | undefined
  const plugins = { activations: { list: () => [{ id: 'fixture', revision, readRoot: f.aRoot }] },
    versions: { read: () => ({ manifest: { tool: { name: 'fixture', description: 'Fixture', parameters: { type: 'object' } } } }) },
    invoke: async () => { invoked++; return { ok: true } },
  } as unknown as PluginService
  const permissions = { request: async () => { beforeApproval?.() } } as unknown as PermissionService
  const make = (sessionId: string) => pluginTools(plugins, permissions, sessionId, randomUUID(), undefined,
    f.workspace.forSession(sessionId)).find(tool => tool.identity === 'plugin:fixture')!
  const context = { callId: 'fixture', signal: new AbortController().signal }
  await assert.rejects(make(f.b.id).execute({}, context), /another directory/)
  assert.equal(invoked, 0)
  await make(f.a.id).execute({}, context)
  assert.equal(invoked, 1)
  beforeApproval = () => { f.workspace.forSession(f.a.id).switch(f.bRoot) }
  await assert.rejects(make(f.a.id).execute({}, context), /Session workspace changed/)
  assert.equal(invoked, 1)
})

test('subagents inherit parent selection, survive another session switch and reject a changed child root', t => {
  const f = fixture(t), child = f.sessions.create('Child')
  f.workspace.forSession(f.a.id).switch(f.bRoot)
  const thread = f.subagents.create(f.a.id, child.id, 'work', 'worker', 'fixture', randomUUID(), 2, 60000)
  assert.equal(thread.workspaceRoot, f.bRoot)
  assert.equal(f.workspace.forSession(child.id).root(), f.bRoot)
  f.workspace.forSession(f.a.id).switch(f.aRoot)
  assert.doesNotThrow(() => assertSubagentWorkspace(f.database, child.id))
  f.workspace.forSession(child.id).switch(f.aRoot)
  assert.throws(() => assertSubagentWorkspace(f.database, child.id), /another workspace/)
})

test('project role import previews bind both session ownership and workspace revision', t => {
  const f = fixture(t), originalToml = 'fixture source'
  const { revision: _revision, source: _source, workspaceRoot: _root, ...definition } = f.subagents.roles(f.a.id).read('worker')
  const input = { entries: [{ scope: 'project', source: '/fixture/roles.toml', originalToml,
    sha256: createHash('sha256').update(originalToml).digest('hex'), definition, issues: [], state: 'review_required' }] }
  const preview = f.subagents.roleImport(f.a.id).preview(input)
  assert.throws(() => f.subagents.roleImport(f.b.id).apply(preview.previewId), /another session/)
  f.workspace.forSession(f.a.id).switch(f.bRoot); f.workspace.forSession(f.a.id).switch(f.aRoot)
  assert.throws(() => f.subagents.roleImport(f.a.id).apply(preview.previewId), /changed after role preview/)
  const fresh = f.subagents.roleImport(f.a.id).preview(input)
  assert.equal(f.subagents.roleImport(f.a.id).apply(fresh.previewId).count, 1)
  assert.equal(f.subagents.roles(f.a.id).read('worker').source, 'project')
  assert.equal(f.subagents.roles(f.b.id).read('worker').source, 'builtin')
})

test('session skill routes cannot change account skills through names or preview identifiers', async t => {
  const f = fixture(t), repository = new SkillRepository(f.database), service = new SkillService(repository)
  const snapshot = createSkillSnapshot({ 'SKILL.md': Buffer.from('---\nname: account-skill\ndescription: fixture\n---\nBody').toString('base64') }, 'account-skill')
  const source = { type: 'generated', uri: '', ref: '', subpath: '' }
  repository.install(repository.preview(snapshot, source, 'user').previewID)
  const preview = repository.preview(snapshot, source, 'user'), routes = skillRoutes(service, f.workspace)
  try {
    await assert.rejects(Promise.resolve(routes['skill.enable']!({ sessionId: f.a.id, name: snapshot.name, enabled: false })), /project scope/)
    await assert.rejects(Promise.resolve(routes['skill.uninstall']!({ sessionId: f.a.id, name: snapshot.name })), /project scope/)
    await assert.rejects(Promise.resolve(routes['skill.install_preview']!({ sessionId: f.a.id, previewId: preview.previewID })), /project scope/)
    assert.throws(() => service.forWorkspace(() => f.aRoot, f.a.id).repository.preview(snapshot, source, 'user'), /project scope/)
    assert.equal(repository.read(snapshot.name).enabled, true)
    assert.equal(repository.install(preview.previewID).scope, 'user')
    await routes['skill.enable']!({ name: snapshot.name, enabled: false })
    assert.equal(repository.read(snapshot.name).enabled, false)
  } finally { await service.close() }
})

test('all session catalogs share one system refresh while retaining independent project refresh and cleanup', async t => {
  const f = fixture(t), catalog = new SystemSkillCatalog([]), repository = new SkillRepository(f.database)
  const load = t.mock.method(catalog, 'load', async () => {})
  const service = new SkillService(repository, catalog)
  const a = service.forWorkspace(() => f.aRoot, f.a.id), b = service.forWorkspace(() => f.bRoot, f.b.id)
  try {
    await Promise.all([a.refresh(), b.refresh()])
    assert.equal(load.mock.callCount(), 1, 'Concurrent first access shares the system catalog initialization')
    await service.refresh()
    assert.equal(load.mock.callCount(), 2, 'Parent refresh scans system once, independent of session count')
    await Promise.all([a.refresh(), b.refresh()])
    assert.equal(load.mock.callCount(), 2, 'Explicit project refresh does not rescan initialized system roots')
    await service.releaseWorkspace(f.a.id)
    assert.throws(() => a.refresh(), /aborted/)
    await b.refresh()
  } finally { await service.close() }
})
