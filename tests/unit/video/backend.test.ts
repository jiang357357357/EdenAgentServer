import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VideoContextBackend } from '../../../src/modules/video/backend.ts'

test('one scope cannot start overlapping cleanup workers and missing setup never launches a subprocess', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-video-missing-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new VideoContextBackend(root), signal = new AbortController().signal
  const first = backend.call('scope-a', 'video_mcp_doctor', {}, signal)
  const second = backend.call('scope-a', 'video_mcp_doctor', {}, signal)
  const otherScope = backend.call('scope-b', 'video_mcp_doctor', {}, signal)
  await assert.rejects(second, /暂忙/)
  await Promise.all([assert.rejects(first, /未安装/), assert.rejects(otherScope, /未安装/)])
  await backend.close()
  await assert.rejects(backend.call('scope-a', 'video_mcp_doctor', {}, signal), /已关闭/)
})
