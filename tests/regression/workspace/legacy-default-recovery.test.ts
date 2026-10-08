import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'

const managed = { version: 1, kind: 'managed', id: 'default' }
const external = (root: string) => ({ version: 1, kind: 'external', path: root })

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-legacy-default-')))
  const database = new EdenDatabase(':memory:', 'local'), sessions = new SessionRepository(database, 'local')
  const suffix = path.join('Data', 'Agent', 'realms', 'mon', 'accounts', 'a'.repeat(64), 'workspace')
  const previous = path.join(directory, '旧安装 已删除', suffix), current = path.join(directory, '新安装', suffix)
  mkdirSync(current, { recursive: true })
  const folder = (name: string) => { const root = path.join(directory, name); mkdirSync(root); return realpathSync(root) }
  const setting = (key: string, value: unknown) => database.connection.prepare('INSERT OR REPLACE INTO runtime_settings VALUES(?,?,?)')
    .run(key, JSON.stringify(value), 1)
  const read = (key: string) => JSON.parse(String(database.connection.prepare('SELECT value_json FROM runtime_settings WHERE key=?').get(key)?.value_json))
  const seed = (title: string, root: string, extra: Record<string, unknown> = {}) => {
    const session = sessions.create(title)
    database.connection.prepare('INSERT INTO session_workspaces(session_id,settings_json,updated_at) VALUES(?,?,?)')
      .run(session.id, JSON.stringify({ 'workspace.root': root, 'workspace.selection': external(root), ...extra }), 1)
    return session.id
  }
  const row = (id: string) => database.connection.prepare('SELECT * FROM session_workspaces WHERE session_id=?').get(id)!
  t.after(() => {
    database.close()
    assert.equal(path.dirname(directory), realpathSync(tmpdir()))
    assert.ok(path.basename(directory).startsWith('eden-legacy-default-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, database, sessions, previous, current: realpathSync(current), folder, setting, read, seed, row }
}

test('24-session customer shape repairs 21 inherited defaults, retains three selected projects and is idempotent', t => {
  const f = fixture(t), project = f.folder('普拉娜的工作报告')
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  const inherited = Array.from({ length: 21 }, (_, i) => f.seed(`旧默认 ${i}`, f.previous))
  const selected = ['5a66a235', '858a2e09', '88116666'].map(title => f.seed(title, project))
  const before = selected.map(id => f.row(id))
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.root(), f.current)
  assert.deepEqual(f.read('workspace.selection'), managed)
  assert.equal(f.read('workspace.selection.default_recovery').recoveredSessions, 21)
  for (const id of inherited) {
    const scope = service.forSession(id)
    assert.equal(scope.root(), f.current)
    assert.equal(scope.info().kind, 'managed')
    assert.equal(f.row(id).revision, 1)
  }
  selected.forEach((id, i) => {
    assert.equal(service.forSession(id).root(), project)
    assert.deepEqual(f.row(id), before[i])
  })
  const newer = f.sessions.create('恢复后新会话')
  assert.equal(service.forSession(newer.id).root(), f.current)
  const snapshots = inherited.map(id => service.forSession(id).snapshot())
  const restarted = new WorkspaceService(f.database, [], f.current)
  inherited.forEach((id, i) => assert.deepEqual(restarted.forSession(id).snapshot(), snapshots[i]))
  assert.equal(f.read('workspace.selection.default_recovery').recoveredSessions, 21)
  assert.equal(existsSync(f.previous), false)
})

test('root-only legacy rows recover across source and portable account layouts', t => {
  const f = fixture(t), oldSource = f.previous.replace(`${path.sep}Data${path.sep}Agent${path.sep}`, `${path.sep}Data${path.sep}`)
  f.setting('workspace.root', oldSource)
  const id = f.seed('尚未初始化 selection', oldSource, { 'workspace.selection': undefined })
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.forSession(id).root(), f.current)
  assert.equal(f.read('workspace.selection.default_recovery').recoveredSessions, 1)
})

test('explicit same-path selections and historical reselection evidence are never repaired', t => {
  const f = fixture(t)
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  const explicit = f.seed('用户手选旧默认', f.previous, { 'workspace.selection.explicit': { selectedAt: 1 } })
  const changed = f.seed('用户改回旧默认', f.previous, { 'workspace.selection.last_projection_change': { previousRoot: 'other' } })
  const deleted = f.seed('已删除会话', f.previous)
  f.sessions.setStatus(deleted, 'deleted')
  const before = [explicit, changed, deleted].map(id => f.row(id))
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(f.read('workspace.selection.default_recovery').recoveredSessions, 0)
  for (const id of [explicit, changed]) assert.equal(service.forSession(id).info().path, f.previous)
  ;[explicit, changed, deleted].forEach((id, i) => assert.deepEqual(f.row(id), before[i]))
})

test('explicit global defaults remain intact while new sessions avoid unavailable seed paths', t => {
  const f = fixture(t)
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  f.setting('workspace.selection.revision', '1')
  const existing = f.seed('旧会话', f.previous)
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.info().path, f.previous)
  assert.equal(service.forSession(existing).info().status, 'missing')
  const id = f.sessions.create('新会话').id
  assert.equal(service.forSession(id).root(), f.current)
  assert.equal(JSON.parse(String(f.row(id).settings_json))['workspace.selection.seed_recovery'].previousRoot, f.previous)
})

test('older global reselection audit protects manual choices made before revision markers existed', t => {
  const f = fixture(t)
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  f.setting('workspace.legacy_import', { state: 'reselected' })
  const id = f.seed('已有会话', f.previous), before = f.row(id)
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.info().path, f.previous)
  assert.deepEqual(f.row(id), before)
  assert.equal(service.forSession(f.sessions.create('不再继承坏路径').id).root(), f.current)
})

test('different account identities and arbitrary missing projects cannot be guessed as managed defaults', t => {
  const f = fixture(t), otherAccount = f.previous.replace('a'.repeat(64), 'b'.repeat(64))
  for (const previous of [otherAccount, path.join(path.dirname(f.previous), 'other', 'workspace')]) {
    f.setting('workspace.root', previous); f.setting('workspace.selection', external(previous))
    const existing = f.seed('未知来源', previous)
    const service = new WorkspaceService(f.database, [], f.current)
    assert.equal(service.info().path, previous)
    assert.equal(service.forSession(existing).info().path, previous)
    assert.equal(service.forSession(f.sessions.create('不继承坏默认').id).root(), f.current)
  }
})

test('existing old directories and missing current defaults are not automatically relocated or created', t => {
  const f = fixture(t)
  mkdirSync(f.previous, { recursive: true })
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.root(), realpathSync(f.previous))
  assert.equal(service.forSession(f.sessions.create('有效默认').id).root(), realpathSync(f.previous))
  const unavailable = path.join(path.dirname(f.current), 'unavailable')
  f.setting('workspace.root', unavailable); f.setting('workspace.selection', external(unavailable))
  const withoutDefault = new WorkspaceService(f.database, [])
  assert.equal(withoutDefault.forSession(f.sessions.create('需选择').id).info().status, 'unselected')
  assert.equal(existsSync(unavailable), false)
})

test('repair is atomic and malformed unrelated rows cannot prevent healthy account startup', t => {
  const f = fixture(t)
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  const id = f.seed('可修复', f.previous), corrupted = f.seed('保留损坏证据', f.previous)
  f.database.connection.prepare('UPDATE session_workspaces SET settings_json=? WHERE session_id=?').run('{broken', corrupted)
  const before = f.row(id)
  assert.throws(() => f.database.transaction(() => {
    new WorkspaceService(f.database, [], f.current)
    throw new Error('startup rollback')
  }), /startup rollback/)
  assert.equal(f.read('workspace.root'), f.previous)
  assert.deepEqual(f.row(id), before)
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.forSession(id).root(), f.current)
  assert.equal(f.row(corrupted).settings_json, '{broken')
})

test('new explicit selection marker preserves session isolation and rejects former approvals', t => {
  const f = fixture(t), project = f.folder('手选项目')
  const service = new WorkspaceService(f.database, [], f.current), a = f.sessions.create('A'), b = f.sessions.create('B')
  const scoped = service.forSession(a.id), peer = service.forSession(b.id), before = scoped.snapshot(), peerBefore = peer.snapshot()
  scoped.switch(project)
  assert.throws(() => scoped.assertSnapshot(before), /changed/)
  assert.deepEqual(peer.snapshot(), peerBefore)
  assert.equal(f.read('workspace.root'), f.current)
  const first = JSON.parse(String(f.row(a.id).settings_json))['workspace.selection.explicit']
  scoped.switch(project)
  assert.notEqual(JSON.parse(String(f.row(a.id).settings_json))['workspace.selection.explicit'].selectionId, first.selectionId)
})

test('default recovery only changes sessions owned by the account database', t => {
  const f = fixture(t), owner = 'owner-account', stranger = 'different-account'
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  const owned = f.seed('当前账号', f.previous), foreign = f.seed('另一个账号', f.previous)
  f.database.connection.prepare('INSERT INTO realm_meta(key,value) VALUES(?,?)').run('account_key', owner)
  f.sessions.ownership.assign(owned, owner); f.sessions.ownership.assign(foreign, stranger)
  const before = f.row(foreign)
  const service = new WorkspaceService(f.database, [], f.current)
  assert.equal(service.forSession(owned).root(), f.current)
  assert.deepEqual(f.row(foreign), before)
  assert.equal(f.read('workspace.selection.default_recovery').recoveredSessions, 1)
})

test('rejecting a dead seed retains default canonical identity and refuses a retargeted junction', t => {
  const f = fixture(t), target = f.folder('其他目录')
  f.setting('workspace.root', f.previous); f.setting('workspace.selection', external(f.previous))
  f.setting('workspace.selection.revision', '1')
  f.setting('workspace.selection.default_resolution', { configuredPath: f.current, canonicalPath: f.current })
  assert.ok(f.current.startsWith(f.directory + path.sep))
  renameSync(f.current, f.current + '-preserved')
  symlinkSync(target, f.current, process.platform === 'win32' ? 'junction' : 'dir')
  const service = new WorkspaceService(f.database, [], f.current)
  const scoped = service.forSession(f.sessions.create('不能隐式换目录').id)
  assert.equal(scoped.info().status, 'invalid')
  assert.throws(() => scoped.root(), /path changed/)
  assert.throws(() => scoped.commandRoot(), /path changed/)
  assert.equal(scoped.info().path, f.current)
})
