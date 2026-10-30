import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { hostRuntimeBundle, unpackHostRuntime } from '../../../src/modules/shared-workspace/host-runtime-bundle.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-runtime-bundle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const targets: Record<string, Record<string, { file: string; size: number; sha256: string; rawSize: number; rawSha256: string }>> = {}
  for (const arch of ['x64', 'arm64']) {
    const target: typeof targets[string] = {}
    for (const name of ['node', 'monpm', 'libstdcpp', 'libgcc']) {
      const raw = Buffer.from(`fixture-${name}-${arch}`), compressed = gzipSync(raw), file = `${name}-linux-${arch}.gz`
      await writeFile(path.join(root, file), compressed)
      target[name] = { file, size: compressed.length, sha256: hash(compressed), rawSize: raw.length, rawSha256: hash(raw) }
    }
    targets[`linux-${arch}`] = target
  }
  const manifest = { schemaVersion: 2, nodeVersion: '22.23.1', targets }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(path.join(root, 'LICENSE.node.txt'), 'fixture Node license')
  await writeFile(path.join(root, 'NOTICE.monpm.txt'), 'fixture MonPM notices')
  await writeFile(path.join(root, 'NOTICE.cpp.txt'), 'fixture C++ notices')
  return { root, manifest }
}

test('runtime bundle selects architecture, validates content and includes the redistribution notices', async t => {
  const f = await fixture(t), x64 = await hostRuntimeBundle(f.root, 'x64'), arm64 = await hostRuntimeBundle(f.root, 'arm64')
  assert.notEqual(x64.id, arm64.id)
  assert.match(x64.notices.node, /Node license/)
  const output = path.join(f.root, 'unpacked')
  await unpackHostRuntime(x64, x64.node, output, new AbortController().signal)
  assert.equal(await readFile(output, 'utf8'), 'fixture-node-x64')
})

test('corrupted compressed assets are rejected before creating an executable', async t => {
  const f = await fixture(t), bundle = await hostRuntimeBundle(f.root, 'x64'), output = path.join(f.root, 'unpacked')
  const filename = path.join(f.root, bundle.node.file), corrupt = await readFile(filename)
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
  await writeFile(filename, corrupt)
  await assert.rejects(unpackHostRuntime(bundle, bundle.node, output, new AbortController().signal), /SHA-256/)
  await assert.rejects(stat(output), error => (error as NodeJS.ErrnoException).code === 'ENOENT')
})

test('wrong architecture metadata and missing runtime notices refuse deployment', async t => {
  const f = await fixture(t)
  f.manifest.targets['linux-x64']!.node!.file = 'node-linux-arm64.gz'
  await writeFile(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest))
  await assert.rejects(hostRuntimeBundle(f.root, 'x64'), /无效/)
  await assert.rejects(hostRuntimeBundle(undefined, 'x64'), /完整|配套/)
  f.manifest.targets['linux-x64']!.node!.file = 'node-linux-x64.gz'
  await writeFile(path.join(f.root, 'manifest.json'), JSON.stringify(f.manifest))
  await rm(path.join(f.root, 'NOTICE.cpp.txt'))
  await assert.rejects(hostRuntimeBundle(f.root, 'x64'), /无效/)
})

test('decompression refuses mismatched raw size and digest', async t => {
  const f = await fixture(t), bundle = await hostRuntimeBundle(f.root, 'x64'), controller = new AbortController()
  await assert.rejects(unpackHostRuntime(bundle, { ...bundle.node, rawSha256: '0'.repeat(64) }, path.join(f.root, 'wrong-hash'), controller.signal), /SHA-256/)
  await assert.rejects(unpackHostRuntime(bundle, { ...bundle.node, rawSize: 1 }, path.join(f.root, 'oversize'), controller.signal), /大小超限/)
})
