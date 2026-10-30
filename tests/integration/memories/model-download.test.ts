import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalMemoryModel, LocalMemoryRetrieval } from '../../../src/modules/memories/index.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { memoryModelRoutes } from '../../../src/transport/rpc/memory-model.routes.ts'
import type { MemoryModelDownload } from '../../../src/modules/memories/model-download-spec.ts'

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-model-download-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const payloads = new Map(['config.json', '1_Pooling/config.json', 'tokenizer.json', 'model.safetensors'].map(name => [name, Buffer.from(`fixture ${name}`)]))
  const spec: MemoryModelDownload = { baseUrl: 'https://fixture.invalid/', files: [...payloads].map(([name, value]) => ({ path: name, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') })) }
  let requests = 0, corrupt = false
  const fetcher: typeof fetch = async input => {
    requests++
    const name = new URL(String(input)).pathname.slice(1), payload = payloads.get(name)!
    return new Response(new Uint8Array(corrupt ? Buffer.alloc(payload.length) : payload))
  }
  const target = path.join(root, 'model'), manager = new LocalMemoryModel(target, spec, fetcher)
  context.after(() => manager.close())
  return { root, target, manager, spec, payloads, requests: () => requests, corrupt: (value: boolean) => { corrupt = value } }
}

test('Local configuration uses its own download directory and missing inference never downloads or reads Core', async context => {
  const f = await fixture(context)
  const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'local', EDEN_AGENT_DATA_ROOT: f.root }, f.root)
  assert.equal(config.memoryModelPath, path.join(f.root, 'models/bge-small-zh-v1.5'))
  assert.equal(loadConfig({ EDEN_AGENT_MEMORY_MODEL_PATH: f.target }, f.root).memoryModelPath, f.target)
  assert.equal(f.manager.status().state, 'missing'); assert.equal(f.requests(), 0)
  const retrieval = new LocalMemoryRetrieval(f.target)
  context.after(() => retrieval.close())
  await assert.rejects(retrieval.retrieve({ sessionId: 'fixture', query: '你好', candidates: [], scope: { scopeType: 'agent_character', scopeKey: '11' } }), /模型文件不完整/)
  assert.equal(f.requests(), 0)
})

test('explicit download is coalesced, verified, atomically installed and reused across restarts', async context => {
  const f = await fixture(context)
  assert.equal(f.manager.download().state, 'downloading')
  assert.equal(f.manager.download().state, 'downloading')
  await f.manager.waitForIdle()
  assert.equal(f.manager.status().state, 'ready')
  assert.equal(f.requests(), 4)
  for (const [name, payload] of f.payloads) assert.deepEqual(await readFile(path.join(f.target, name)), payload)
  const restarted = new LocalMemoryModel(f.target, f.spec, async () => { throw new Error('must not download twice') })
  assert.equal(restarted.download().state, 'ready')
  await restarted.close()
  assert.deepEqual((await readdir(f.root)).filter(name => name.includes('.download-')), [])
})

test('hash failure keeps target absent, cleans staging and permits retry', async context => {
  const f = await fixture(context)
  f.corrupt(true); f.manager.download(); await f.manager.waitForIdle()
  assert.equal(f.manager.status().state, 'error')
  assert.match(f.manager.status().error!, /校验/)
  assert.equal(existsSync(f.target), false)
  assert.deepEqual(await readdir(f.root), [])
  f.corrupt(false); f.manager.download(); await f.manager.waitForIdle()
  assert.equal(f.manager.status().state, 'ready')
})

test('cancel removes only owned staging and never exposes a partial model', async context => {
  const f = await fixture(context)
  let started!: () => void
  const downloading = new Promise<void>(resolve => { started = resolve })
  const model = new LocalMemoryModel(f.target, f.spec, async (_input, init) => {
    started()
    await new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      init!.signal!.throwIfAborted()
    })
    throw new Error('unreachable')
  })
  context.after(() => model.close())
  model.download(); await downloading
  assert.equal((await model.cancel()).state, 'cancelled')
  assert.equal(existsSync(f.target), false)
  assert.deepEqual(await readdir(f.root), [])
})

test('existing incomplete directories are preserved and Mon RPC refuses Local downloads', async context => {
  const f = await fixture(context)
  await mkdir(f.target); await writeFile(path.join(f.target, 'personal.txt'), 'keep')
  assert.throws(() => f.manager.download(), /目录已存在/)
  assert.equal(await readFile(path.join(f.target, 'personal.txt'), 'utf8'), 'keep')
  const routes = memoryModelRoutes(undefined)
  assert.equal((await routes['memory.model.status']({}) as { state: string }).state, 'core')
  await assert.rejects(routes['memory.model.download']({ confirm: true }), /Core 内置/)
  await assert.rejects(memoryModelRoutes(f.manager)['memory.model.download']({}), /confirm/)
})

test('validated Local RPC contracts expose download progress and reuse the installed model', async context => {
  const f = await fixture(context), routes = memoryModelRoutes(f.manager)
  assert.equal((await routes['memory.model.status']({}) as { state: string }).state, 'missing')
  assert.equal((await routes['memory.model.download']({ confirm: true }) as { state: string }).state, 'downloading')
  await f.manager.waitForIdle()
  const ready = await routes['memory.model.status']({}) as { state: string; downloadedBytes: number; totalBytes: number }
  assert.equal(ready.state, 'ready'); assert.equal(ready.downloadedBytes, ready.totalBytes)
  assert.equal((await routes['memory.model.cancel']({}) as { state: string }).state, 'ready')
  await assert.rejects(routes['memory.model.status']({ path: 'forbidden' }))
})
