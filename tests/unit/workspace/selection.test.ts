import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { WorkspaceService } from '../../../src/modules/workspace/workspace-service.ts'
import { WorkspaceRepository } from '../../../src/modules/workspace/workspace-repository.ts'

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-workspace-selection-')))
  const database = new EdenDatabase(':memory:', 'local')
  const folder = (name: string) => { const root = path.join(directory, name); mkdirSync(root, { recursive: true }); return realpathSync(root) }
  const setting = (key: string) => database.connection.prepare('SELECT value_json FROM runtime_settings WHERE key=?').get(key)?.value_json
  const legacy = (root: string) => database.connection.prepare('INSERT INTO runtime_settings VALUES(?,?,?)').run('workspace.root', JSON.stringify(root), 1)
  return { directory, database, folder, setting, legacy, close() { database.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('new default is a logical selection and restarting at a relocated default derives its current path', () => {
  const f = fixture()
  try {
    const original = f.folder('original')
    const moved = path.join(f.directory, 'moved')
    const first = new WorkspaceService(f.database, [], original)
    assert.equal(first.info().kind, 'managed')
    assert.deepEqual(JSON.parse(String(f.setting('workspace.selection'))), { version: 1, kind: 'managed', id: 'default' })
    renameSync(original, moved)
    const second = new WorkspaceService(f.database, [], moved)
    assert.equal(second.root(), realpathSync(moved))
    assert.equal(second.info().status, 'ready')
    assert.equal(new WorkspaceRepository(f.database).read(), realpathSync(moved))
    const audit = JSON.parse(String(f.setting('workspace.selection.last_projection_change')))
    assert.equal(audit.previousRoot, original)
    assert.equal(audit.currentRoot, moved)
  } finally { f.close() }
})

test('legacy path equal to the current canonical default migrates once with its original value retained', () => {
  const f = fixture()
  try {
    const root = f.folder('default')
    f.legacy(root)
    const workspace = new WorkspaceService(f.database, [], root)
    assert.equal(workspace.info().kind, 'managed')
    const audit = f.setting('workspace.selection.migration')
    assert.equal(JSON.parse(String(audit)).previousRoot, root)
    assert.equal(JSON.parse(String(audit)).reason, 'matches-current-default')
    new WorkspaceService(f.database, [], root)
    assert.equal(f.setting('workspace.selection.migration'), audit)
  } finally { f.close() }
})

test('missing legacy path keeps external ownership even when its suffix resembles the new default', () => {
  const f = fixture()
  try {
    const old = path.join(f.directory, 'old', 'workspace')
    const current = f.folder('new/workspace')
    f.legacy(old)
    const workspace = new WorkspaceService(f.database, [], current)
    assert.deepEqual(workspace.info(), { name: 'workspace', path: old, kind: 'external', status: 'missing', defaultPath: current,
      error: 'Workspace directory is missing; select it again or restore the directory' })
    assert.equal(workspace.availableRoot(), '')
    assert.throws(() => workspace.commandRoot(), /missing/)
    assert.equal(new WorkspaceRepository(f.database).read(), old)
    assert.equal(JSON.parse(String(f.setting('workspace.selection.migration'))).reason, 'unproven-legacy-origin')
  } finally { f.close() }
})

test('an explicitly selected external directory stays external even when it equals the default', () => {
  const f = fixture()
  try {
    const root = f.folder('default')
    const workspace = new WorkspaceService(f.database, [], root)
    workspace.switch(root)
    const restarted = new WorkspaceService(f.database, [], root)
    assert.equal(restarted.info().kind, 'external')
    assert.equal(restarted.root(), root)
  } finally { f.close() }
})

test('missing managed default remains selected and cannot fall back to the home directory', () => {
  const f = fixture()
  try {
    const absent = path.join(f.directory, 'absent')
    const workspace = new WorkspaceService(f.database, [], absent)
    assert.equal(workspace.info().kind, 'managed')
    assert.equal(workspace.info().path, absent)
    assert.equal(workspace.info().status, 'missing')
    assert.throws(() => workspace.root(), /missing/)
    assert.throws(() => workspace.commandRoot(), /missing/)
    mkdirSync(absent)
    assert.equal(workspace.root(), realpathSync(absent))
  } finally { f.close() }
})

test('a genuinely unselected workspace retains the existing command home behavior', () => {
  const f = fixture()
  try {
    const workspace = new WorkspaceService(f.database, [])
    assert.equal(workspace.info().status, 'unselected')
    assert.equal(workspace.info().kind, 'none')
    assert.equal(workspace.commandRoot(), realpathSync(homedir()))
    assert.throws(() => workspace.root(), /Select a workspace/)
  } finally { f.close() }
})

test('files and relative legacy paths are invalid selections rather than startup failures', () => {
  const f = fixture()
  try {
    const filename = path.join(f.directory, 'file')
    writeFileSync(filename, 'not a directory')
    f.legacy(filename)
    const workspace = new WorkspaceService(f.database, [])
    assert.equal(workspace.info().status, 'invalid')
    assert.equal(workspace.info().path, filename)
    assert.throws(() => workspace.commandRoot(), /directory/)
    new WorkspaceRepository(f.database).set('relative/workspace')
    assert.equal(workspace.info().status, 'invalid')
    assert.throws(() => workspace.root(), /absolute/)
  } finally { f.close() }
})

test('managed selections without startup configuration retain their last path but reject execution', () => {
  const f = fixture()
  try {
    const root = f.folder('default')
    new WorkspaceService(f.database, [], root)
    const restarted = new WorkspaceService(f.database, [])
    assert.equal(restarted.info().path, root)
    assert.equal(restarted.info().status, 'invalid')
    assert.throws(() => restarted.root(), /not configured/)
  } finally { f.close() }
})

test('explicit default recovery works inside an owning transaction and recreates a deleted default leaf', () => {
  const f = fixture()
  try {
    const root = f.folder('default')
    f.legacy(path.join(f.directory, 'missing'))
    const workspace = new WorkspaceService(f.database, [], root)
    f.database.transaction(() => workspace.useDefault())
    assert.equal(workspace.root(), root)
    assert.equal(workspace.info().kind, 'managed')
    rmSync(root, { recursive: true })
    assert.equal(workspace.info().status, 'missing')
    f.database.transaction(() => workspace.useDefault())
    assert.equal(workspace.root(), root)
    assert.equal(workspace.info().kind, 'managed')
  } finally { f.close() }
})

test('explicit default recovery does not recreate missing ancestors or replace a conflicting file', () => {
  const f = fixture()
  try {
    const existing = f.folder('external')
    const root = path.join(f.directory, 'missing-parent', 'default')
    const workspace = new WorkspaceService(f.database, [], root)
    workspace.switch(existing)
    assert.throws(() => workspace.useDefault(), { code: 'ENOENT' })
    assert.equal(workspace.root(), existing)
    assert.equal(workspace.info().kind, 'external')
    mkdirSync(path.dirname(root))
    writeFileSync(root, 'conflict')
    assert.throws(() => workspace.useDefault(), /must be a directory/)
    assert.equal(workspace.root(), existing)
    const unconfigured = new WorkspaceService(f.database, [])
    assert.throws(() => unconfigured.useDefault(), /not configured/)
    assert.equal(workspace.root(), existing)
  } finally { f.close() }
})

test('switching away and back clears remembered write snapshots', async () => {
  const f = fixture()
  try {
    const first = f.folder('first'), second = f.folder('second')
    const filename = path.join(first, 'note.txt')
    writeFileSync(filename, 'original')
    const workspace = new WorkspaceService(f.database, [], first)
    workspace.rememberWrite('scope', 'note.txt', 'original')
    workspace.switch(second)
    writeFileSync(filename, 'new content')
    workspace.useDefault()
    assert.equal(await workspace.writeSnapshot('scope', 'note.txt'), createHash('sha256').update('new content').digest('hex'))
  } finally { f.close() }
})

test('queued mutations recheck availability before executing approved work', async () => {
  const f = fixture()
  try {
    const root = f.folder('default')
    const workspace = new WorkspaceService(f.database, [], root)
    let executed = false
    rmSync(root, { recursive: true })
    await assert.rejects(workspace.mutateCommand(root, new AbortController().signal, async () => { executed = true }), /missing/)
    assert.equal(executed, false)
  } finally { f.close() }
})

test('replacing a selected directory with a junction cannot silently retarget execution', () => {
  const f = fixture()
  try {
    const root = f.folder('selected'), target = f.folder('target')
    const workspace = new WorkspaceService(f.database, [], root)
    rmSync(root, { recursive: true })
    symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(workspace.info().status, 'invalid')
    assert.throws(() => workspace.commandRoot(), /path changed/)
    const restarted = new WorkspaceService(f.database, [], root)
    assert.equal(restarted.info().status, 'invalid')
    assert.throws(() => restarted.root(), /path changed/)
    assert.throws(() => f.database.transaction(() => {
      restarted.useDefault()
      assert.equal(restarted.root(), target)
      throw new Error('event persistence failed')
    }), /event persistence failed/)
    assert.equal(restarted.info().status, 'invalid')
    restarted.useDefault()
    assert.equal(restarted.root(), target)
    assert.equal(new WorkspaceService(f.database, [], root).root(), target)
  } finally { f.close() }
})

test('invalid persisted selection fails explicitly and does not overwrite database evidence', () => {
  const f = fixture()
  try {
    const malformed = JSON.stringify({ version: 99, kind: 'managed', id: 'default' })
    f.database.connection.prepare('INSERT INTO runtime_settings VALUES(?,?,?)').run('workspace.selection', malformed, 1)
    assert.throws(() => new WorkspaceService(f.database, [], f.folder('default')), /Invalid persisted workspace selection/)
    assert.equal(f.setting('workspace.selection'), malformed)
    assert.equal(f.setting('workspace.selection.migration'), undefined)
  } finally { f.close() }
})
