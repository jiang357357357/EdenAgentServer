import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchWorkspace } from '../../../src/modules/workspace/workspace-search.ts'

test('workspace search preserves filename precedence and skips excluded or non-text content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-search-'))
  try {
    await mkdir(path.join(root, '.git'))
    await Promise.all([
      writeFile(path.join(root, 'needle.txt'), 'needle in the body'),
      writeFile(path.join(root, 'content.txt'), 'first\r\n  NEEDLE content  \r\nthird'),
      writeFile(path.join(root, 'binary.bin'), Buffer.from([0, ...Buffer.from('needle')])),
      writeFile(path.join(root, 'invalid.txt'), Buffer.from([255, ...Buffer.from('needle')])),
      writeFile(path.join(root, 'large.txt'), 'needle'.repeat(100000)),
      writeFile(path.join(root, '.git', 'hidden.txt'), 'needle'),
    ])
    const result = await searchWorkspace(root, '', 'needle', 20, new AbortController().signal)
    assert.deepEqual(result.matches.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'content.txt', line: 2, preview: 'NEEDLE content' },
      { path: 'needle.txt', line: null, preview: 'needle.txt' },
    ])
    assert.equal(result.scannedFiles, 5)
    assert.equal(result.truncated, false)
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.budgetMs, 120_000)
    assert.equal(result.workerStopped, true)
    assert.equal(result.skippedFiles, 3)
    const bounded = await searchWorkspace(root, '', 'needle', 1, new AbortController().signal)
    assert.equal(bounded.matches.length, 1)
    assert.equal(bounded.truncated, true)
    assert.equal(bounded.stopReason, 'match_limit')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace search honors cancellation before traversing a selected directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-search-abort-'))
  try {
    const controller = new AbortController()
    const reason = new Error('search cancelled')
    controller.abort(reason)
    await assert.rejects(searchWorkspace(root, '', 'needle', 20, controller.signal), error => error === reason)
  } finally { await rm(root, { recursive: true, force: true }) }
})
