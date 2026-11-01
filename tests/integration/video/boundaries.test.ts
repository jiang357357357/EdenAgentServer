import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { toJson } from '@eden/api'
import { videoFixture } from './fixture.ts'
import type { VideoBackend } from '../../../src/modules/video/backend.ts'
import { privateToolHistoryEntries } from '../../../src/modules/tool-results/index.ts'

test('video tools stage exact accepted bytes and remove the temporary source after a call', async t => {
  let staged = '', directory = ''
  const bytes = Buffer.from('accepted bytes')
  const backend: VideoBackend = { async call(scope, name, args) {
    directory = scope; staged = (args as any).path
    assert.equal(name, 'inspect_local_video')
    assert.deepEqual(await readFile(staged), bytes)
    return toJson({ structuredContent: { source: { width: 320 }, security: { internal: true } } })
  }, async close() {} }
  const f = await videoFixture(backend); t.after(() => f.close())
  const blob = await f.accept(bytes)
  const raw = await f.execute('inspect_video', { source: { attachment: blob.id } })
  assert.ok(directory.startsWith(path.join(f.root, 'video')))
  await assert.rejects(access(staged))
  assert.deepEqual(f.tools().find(tool => tool.name === 'inspect_video')!.modelResult!(raw, {}), { source: { width: 320, display_title_or_filename: 'video.mp4' } })
})

test('foreign blobs, traversal, unsupported formats and aborted calls do not reach the media worker', async t => {
  let calls = 0
  const f = await videoFixture({ async call() { calls++; return {} }, async close() {} }); t.after(() => f.close())
  await f.accept(Buffer.from('video'))
  const foreign = await f.blobs.put(Buffer.from('foreign'), 'video/mp4')
  await assert.rejects(f.execute('inspect_video', { source: { attachment: foreign.id } }), /当前输入/)
  await assert.rejects(f.execute('inspect_video', { source: { path: '../outside.mp4' } }))
  // Use a file MIME for an unsupported movie extension; no image decoder is involved.
  const file = await f.accept(Buffer.from('not movie'), 'movie.exe', 'application/octet-stream')
  await assert.rejects(f.execute('inspect_video', { source: { attachment: file.id } }), /格式/)
  const current = await f.accept(Buffer.from('movie'))
  await assert.rejects(f.execute('inspect_video', { source: { attachment: current.id } }, undefined, AbortSignal.abort()))
  assert.equal(calls, 0)
})

test('denied approval stops staging and QQ groups share the private video permissions', async t => {
  let calls = 0
  const backend: VideoBackend = { async call() { calls++; return { structuredContent: { status: 'complete' } } }, async close() {} }
  const app = await videoFixture(backend); t.after(() => app.close())
  const blob = await app.accept(Buffer.from('movie')); app.permissions.setMode('restricted')
  const pending = app.execute('inspect_video', { source: { attachment: blob.id } })
  await setImmediate()
  const permission = app.permissions.list().find(row => row.state === 'pending')!
  assert.ok(permission); app.permissions.resolve(permission.id, false)
  await assert.rejects(pending, /Permission denied/)
  assert.equal(calls, 0)
  const group = await videoFixture(backend, 'group'); t.after(() => group.close())
  const video = await group.accept(Buffer.from('movie'))
  await group.execute('inspect_video', { source: { attachment: video.id } })
  assert.equal(calls, 1)
  await assert.rejects(group.execute('prepare_video', { source: { path: 'video.mp4' } }), /QQ/)
  await group.execute('prepare_video', { source: { youtubeUrl: 'https://youtu.be/abcdefghijk' } })
  assert.equal(calls, 2)
})

test('video job storage is stable across turns and differs between sessions and acting characters', async t => {
  const scopes: string[] = []
  const backend: VideoBackend = { async call(scope) { scopes.push(scope); return {} }, async close() {} }
  const a = await videoFixture(backend), b = await videoFixture(backend); t.after(async () => { await a.close(); await b.close() })
  await a.accept(Buffer.from('movie')); await b.accept(Buffer.from('movie'))
  const job_id = 'A'.repeat(32)
  await a.execute('read_video_timeline', { job_id }, 1)
  a.next(); await a.execute('read_video_timeline', { job_id }, 1)
  await a.execute('read_video_timeline', { job_id }, 2)
  await b.execute('read_video_timeline', { job_id }, 1)
  assert.equal(scopes[0], scopes[1]); assert.notEqual(scopes[0], scopes[2]); assert.notEqual(scopes[0], scopes[3])
})

test('invalid ranges and frame counts fail validation; historical video projections preserve useful IDs and omit internals', async t => {
  const f = await videoFixture({ async call() { throw new Error('must not call') }, async close() {} }); t.after(() => f.close())
  const blob = await f.accept(Buffer.from('movie'))
  await assert.rejects(f.execute('prepare_video', { source: { attachment: blob.id }, range: { start_time_seconds: 10, end_time_seconds: 2 } }))
  await assert.rejects(f.execute('get_video_frames', { job_id: 'A'.repeat(32), frame_ids: ['f_000001', 'f_000001'] }))
  const history = privateToolHistoryEntries([{ message: { role: 'toolResult', toolName: 'prepare_video', modelSource: 'builtin',
    toolCallId: randomUUID(), details: { structuredContent: { job_id: 'A'.repeat(32), status: 'complete',
      cache: { internal: 'private' }, resources: { timeline: 'videoctx://hidden' }, security: { allowed: 'secret' } } }, content: [] } }])
  assert.match(JSON.stringify(history), /A{32}/)
  assert.doesNotMatch(JSON.stringify(history), /private|hidden|secret/)
})
