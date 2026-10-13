import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchWorkspace } from '../../../src/modules/workspace/workspace-search.ts'
import { SEARCH_ENTRY_LIMIT, SEARCH_FILE_LIMIT } from '../../../src/modules/workspace/workspace-search-contracts.ts'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-search-limits-'))
  return { root, async close() {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  } }
}

test('file limit reports partial completion rather than a successful exhaustive search', async () => {
  const data = await fixture()
  try {
    // Empty files exercise the real scanner without large test data or user directories.
    for (let offset = 0; offset < SEARCH_FILE_LIMIT + 1; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, SEARCH_FILE_LIMIT + 1 - offset) }, (_, index) =>
        writeFile(path.join(data.root, `file-${offset + index}.txt`), '')))
    }
    const result = await searchWorkspace(data.root, '.', 'not-present', 20, new AbortController().signal)
    assert.equal(result.stopReason, 'file_limit')
    assert.equal(result.scannedFiles, SEARCH_FILE_LIMIT)
    assert.equal(result.truncated, true)
    assert.equal(result.workerStopped, true)
    assert.deepEqual(result.matches, [])
  } finally { await data.close() }
})

test('entry limit bounds directory-only traversals independently from the file limit', async () => {
  const data = await fixture()
  try {
    for (let offset = 0; offset < SEARCH_ENTRY_LIMIT + 1; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, SEARCH_ENTRY_LIMIT + 1 - offset) }, (_, index) =>
        mkdir(path.join(data.root, `folder-${offset + index}`))))
    }
    const result = await searchWorkspace(data.root, '.', 'not-present', 20, new AbortController().signal)
    assert.equal(result.stopReason, 'entry_limit')
    assert.equal(result.visitedEntries, SEARCH_ENTRY_LIMIT)
    assert.equal(result.scannedFiles, 0)
    assert.equal(result.truncated, true)
    assert.equal(result.workerStopped, true)
  } finally { await data.close() }
})

test('literal queries stay literal, and a narrowed directory excludes other workspace matches', async () => {
  const data = await fixture()
  try {
    await mkdir(path.join(data.root, 'sub'))
    await writeFile(path.join(data.root, 'outside.txt'), 'alpha|beta')
    await writeFile(path.join(data.root, 'sub', 'inside.txt'), 'alpha\nalpha|beta')
    const result = await searchWorkspace(data.root, 'sub', 'ALPHA|BETA', 20, new AbortController().signal)
    assert.deepEqual(result.matches, [{ path: path.join('sub', 'inside.txt'), line: 2, preview: 'alpha|beta' }])
    assert.equal(result.stopReason, 'completed')
    await assert.rejects(searchWorkspace(data.root, '..', 'alpha', 20, new AbortController().signal), /Path escapes the workspace/)
  } finally { await data.close() }
})
