import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { WorkspaceService, workspaceTools } from '../../../src/modules/workspace/index.ts'
import { CommandService } from '../../../src/modules/commands/index.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-file-ops-')), db = new EdenDatabase(':memory:', 'local')
  const workspace = new WorkspaceService(db, []); workspace.switch(root)
  let before = async () => {}, denied = false
  const requests: unknown[] = [], permissions = { async request(...args: unknown[]) { requests.push(args); await before(); if (denied) throw new Error('Denied') } } as unknown as PermissionService
  const tools = (session = 'session', turn = 'turn') => workspaceTools(workspace, permissions, session, turn, new CommandService(db, []))
  const call = (name: string, input: Record<string, unknown>, catalog = tools(), signal = new AbortController().signal) => catalog.find(tool => tool.name === name)!.execute(input, { callId: 'call', signal }) as Promise<any>
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }) })
  return { root, workspace, call, tools, requests, hook: (fn: () => Promise<void>) => { before = fn }, deny: () => { denied = true } }
}

test('delete and rename preserve recoverable independent binary bytes across turns and reject overwrites and foreign sessions', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 1, 2, 250, 255])
  await writeFile(path.join(f.root, 'source.bin'), bytes)
  if (process.platform !== 'win32') await chmod(path.join(f.root, 'source.bin'), 0o755)
  const renamed = await f.call('rename_file', { path: 'source.bin', destination: 'renamed.bin' })
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.root, 'renamed.bin'))).mode & 0o777, 0o755)
  await assert.rejects(readFile(path.join(f.root, 'source.bin')), /ENOENT/)
  await writeFile(path.join(f.root, 'renamed.bin'), 'changed later')
  await f.call('restore_file', { recoveryId: renamed.recoveryId }, f.tools('session', 'next-turn'))
  assert.deepEqual(await readFile(path.join(f.root, 'source.bin')), bytes)
  await assert.rejects(f.call('restore_file', { recoveryId: renamed.recoveryId }), /EEXIST/)
  await assert.rejects(f.call('restore_file', { recoveryId: renamed.recoveryId }, f.tools('other-session')), /不属于/)
  await assert.rejects(f.call('rename_file', { path: 'source.bin', destination: 'renamed.bin' }), /已存在/)
  const deleted = await f.call('delete_file', { path: 'source.bin' })
  await f.call('restore_file', { recoveryId: deleted.recoveryId })
  assert.deepEqual(await readFile(path.join(f.root, 'source.bin')), bytes)
})

test('approval denial, cancellation, external edits, directory deletes and escape paths leave original data intact', async t => {
  for (const reason of ['denied', 'cancelled', 'changed', 'directory', 'escape', 'selection']) await t.test(reason, async child => {
    const f = await fixture(child), filename = path.join(f.root, 'keep.txt')
    await writeFile(filename, 'original'); await mkdir(path.join(f.root, 'folder'))
    const controller = new AbortController()
    if (reason === 'denied') f.deny()
    if (reason === 'cancelled') f.hook(async () => controller.abort())
    if (reason === 'changed') f.hook(async () => { await writeFile(filename, 'concurrent') })
    if (reason === 'selection') f.hook(async () => { f.workspace.switch(path.join(f.root, 'folder')) })
    await assert.rejects(f.call('delete_file', { path: reason === 'directory' ? 'folder' : reason === 'escape' ? '../outside' : 'keep.txt' }, f.tools(), controller.signal))
    assert.equal(await readFile(filename, 'utf8'), reason === 'changed' ? 'concurrent' : 'original')
  })
})
