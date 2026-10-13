import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { workspaceReadTools } from '../../../src/modules/workspace/workspace-read-tools.ts'

async function fixture() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'eden-search-location-'))
  const database = new EdenDatabase(':memory:', 'local')
  return { scratch, database, async close() {
    database.close()
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()))
    await rm(scratch, { recursive: true, force: true })
  } }
}

test('search tool uses persisted workspace identity without inspecting host filesystem first', async () => {
  const data = await fixture()
  try {
    const project = path.join(data.scratch, 'selected')
    await mkdir(project)
    await writeFile(path.join(project, 'note.txt'), 'needle')
    const workspace = new WorkspaceService(data.database, [])
    workspace.switch(project)
    workspace.info = () => { throw new Error('Unexpected host filesystem inspection') }
    const tool = workspaceReadTools(workspace, 'search-location').find(tool => tool.name === 'search_files')!
    const result = await tool.execute({ query: 'needle' }, { callId: 'test-search', signal: new AbortController().signal }) as {
      matches: Array<{ path: string }>; budgetMs: number; stopReason: string
    }
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.budgetMs, 120_000)
    assert.equal(result.matches[0]!.path, 'note.txt')
    for (const field of ['budgetMs', 'timeoutSeconds', 'worker', 'expectedRoot']) {
      await assert.rejects(tool.execute({ query: 'needle', [field]: 'injected' },
        { callId: 'invalid-input', signal: new AbortController().signal }))
    }
  } finally { await data.close() }
})

test('managed default through a junction keeps its canonical identity and rejects redirection in the worker', async () => {
  const data = await fixture()
  try {
    const original = path.join(data.scratch, 'original')
    const other = path.join(data.scratch, 'other')
    const alias = path.join(data.scratch, 'configured-default')
    await mkdir(original)
    await mkdir(other)
    await writeFile(path.join(original, 'note.txt'), 'needle original')
    await writeFile(path.join(other, 'secret.txt'), 'needle outside')
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const workspace = new WorkspaceService(data.database, [], alias)
    const tool = workspaceReadTools(workspace, 'managed-location').find(tool => tool.name === 'search_files')!
    workspace.info = () => { throw new Error('Unexpected host filesystem inspection') }
    const result = await tool.execute({ query: 'needle' }, { callId: 'valid', signal: new AbortController().signal }) as {
      matches: Array<{ path: string }>
    }
    assert.deepEqual(result.matches.map(match => match.path), ['note.txt'])
    // Remove the verified fixture's link itself, without recursive deletion of either target.
    await rm(alias)
    await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(tool.execute({ query: 'needle' }, { callId: 'redirected', signal: new AbortController().signal }),
      /Workspace path changed; select it again/)
  } finally { await data.close() }
})

test('search still rejects an unselected workspace before starting a scanner', async () => {
  const data = await fixture()
  try {
    const workspace = new WorkspaceService(data.database, [])
    const tool = workspaceReadTools(workspace, 'unselected').find(tool => tool.name === 'search_files')!
    await assert.rejects(tool.execute({ query: 'needle' }, { callId: 'unselected', signal: new AbortController().signal }),
      /Select a workspace first/)
  } finally { await data.close() }
})
