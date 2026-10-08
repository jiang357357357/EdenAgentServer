import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { permissionScope } from '@eden/permissions'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { qqFileTool } from '../../../src/modules/qq-channel/file-tool.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-qq-file-scope-')))
  const first = path.join(directory, 'first'), second = path.join(directory, 'second')
  for (const root of [first, second]) { mkdirSync(root); writeFileSync(path.join(root, 'note.txt'), root) }
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  const session = repository.create('QQ file scope', [{ assistantId: 1, characterId: 2 }], null, { purpose: 'user_chat', sourceChannel: 'qq' })
  const permissions = new PermissionService(database, repository.events)
  const blobs = new BlobService(path.join(directory, 'blobs'), new BlobRepository(database))
  const workspace = new WorkspaceService(database, [], first)
  const controller = new AbortController()
  const tool = qqFileTool(repository, blobs, workspace, permissions, session.id, session.id)
  let call = 0
  const execute = () => tool.execute({ path: 'note.txt' }, { callId: String(++call), signal: controller.signal })
  const pending = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const request = permissions.list().find(item => item.state === 'pending')
      if (request) return request
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Expected QQ file permission request')
  }
  const queued = () => Number(database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='qq.file_requested'").get()?.n)
  return { first, second, database, workspace, permissions, execute, pending, queued,
    close() { controller.abort(); database.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('QQ file approval details bind the canonical workspace as well as the relative filename', async () => {
  const f = fixture()
  try {
    const firstRun = f.execute()
    const first = await f.pending()
    assert.deepEqual(first.details, { path: 'note.txt', filename: 'note.txt', workspaceRoot: f.first })
    f.permissions.resolve(first.id, true)
    await firstRun
    f.workspace.switch(f.second)
    const secondRun = f.execute()
    const second = await f.pending()
    assert.deepEqual(second.details, { path: 'note.txt', filename: 'note.txt', workspaceRoot: f.second })
    const scope = (request: typeof first) => permissionScope(request.sessionId, request.capability, request.resource, request.details)
    assert.notEqual(scope(first), scope(second))
    f.permissions.resolve(second.id, true)
    await secondRun
    assert.equal(f.queued(), 2)
  } finally { f.close() }
})

test('switching workspaces while QQ approval is pending creates no blob or file delivery', async () => {
  const f = fixture()
  try {
    const running = f.execute()
    const rejected = assert.rejects(running, /Workspace changed after QQ file permission request/)
    const pending = await f.pending()
    f.workspace.switch(f.second)
    f.permissions.resolve(pending.id, true)
    await rejected
    assert.equal(f.queued(), 0)
    assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM blobs').get()?.n, 0)
  } finally { f.close() }
})

test('a missing selected workspace rejects QQ file sending before approval without using the home directory', async () => {
  const f = fixture()
  try {
    rmSync(f.first, { recursive: true })
    await assert.rejects(f.execute(), /Workspace directory is missing/)
    assert.equal(f.permissions.list().length, 0)
    assert.equal(f.queued(), 0)
    assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM blobs').get()?.n, 0)
  } finally { f.close() }
})
