import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRuntime } from '@eden/runtime-pi'
import { recordedModel, callbacks } from '@eden/runtime-pi/testing'
import { videoFixture, makeVideo, runtimeRoot } from './fixture.ts'

const available = existsSync(path.join(runtimeRoot, 'runtime.json'))
test('live VideoContext: attachment, audio worker, four scenes, scoped jobs, 256K model images and cleanup', { skip: !available, timeout: 180000 }, async t => {
  const f = await videoFixture(); t.after(() => f.close())
  const filename = path.join(f.workspaceRoot, '四幕 视频.mp4'); await makeVideo(filename)
  const blob = await f.accept(await readFile(filename), '四幕 视频.mp4')
  const doctor: any = await f.execute('video_context_doctor', {})
  assert.equal(doctor.isError, false)
  assert.equal(doctor.structuredContent.default_model, 'tiny')
  assert.ok(doctor.structuredContent.installed_approved_models.includes('tiny'))
  const inspection: any = await f.execute('inspect_video', { source: { attachment: blob.id } })
  assert.notEqual(inspection.isError, true)
  assert.equal(inspection.structuredContent.source.width, 320)
  assert.equal(inspection.structuredContent.source.display_title_or_filename, '四幕 视频.mp4')
  const prepared: any = await f.execute('prepare_video', { source: { attachment: blob.id },
    sampling: { mode: 'timestamps', timestamps_seconds: [1, 3, 5, 7], near_duplicates: { enabled: false } } })
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared))
  assert.equal(prepared.structuredContent.status, 'complete')
  assert.notEqual(prepared.structuredContent.processing.transcript_status, 'unavailable')
  assert.equal(prepared.structuredContent.processing.final_frames, 4)
  assert.equal(prepared.structuredContent.source.display_title_or_filename, '四幕 视频.mp4')
  const job_id = prepared.structuredContent.job_id
  f.next()
  const timeline: any = await f.execute('read_video_timeline', { job_id })
  assert.notEqual(timeline.isError, true)
  const lines = timeline.structuredContent.content.split('\n').filter((line: string) => line.startsWith('F\t'))
  assert.equal(lines.length, 4)
  assert.deepEqual(lines.map((line: string) => Number(line.split('\t')[1])), [1000, 3000, 5000, 7000])
  const frame_ids: string[] = lines.map((line: string) => line.split('\t')[2])
  const previews: any = await f.execute('get_video_frame_previews', { job_id, frame_ids, max_previews: 4 })
  assert.notEqual(previews.isError, true, JSON.stringify(previews))
  assert.equal(previews.content.filter((item: any) => item.type === 'image').length, 4)
  const foreign: any = await f.execute('get_video_frames', { job_id, frame_ids }, 'other-actor')
  assert.equal(foreign.isError, true)
  const model = await recordedModel([{ tool: 'get_video_frames', input: { job_id, frame_ids, max_frames: 4 } }, { text: '画面已收到' }])
  t.after(() => model.close())
  const record = callbacks()
  const runtime = createRuntime({ sessionId: f.session.id, systemPrompt: '测试视频关键帧传递', model: { ...model.config, contextWindow: 262144 },
    tools: f.tools().filter(tool => tool.name === 'get_video_frames'), callbacks: record.handlers })
  t.after(() => runtime.dispose?.())
  await runtime.prompt('查看四张关键帧')
  assert.equal(model.requests.length, 2)
  const imageParts = model.requests.flatMap(request => (request.messages as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])).filter(part => part.type === 'image_url')
  assert.equal(imageParts.length, 4)
  assert.ok(imageParts.every(part => part.image_url.url.startsWith('data:image/jpeg;base64,')))
  const imageBytes = Buffer.from(imageParts[0].image_url.url.split(',')[1], 'base64')
  assert.deepEqual([...imageBytes.subarray(0, 3)], [255, 216, 255])
  const projection = f.tools().find(tool => tool.name === 'prepare_video')!.modelResult!(prepared, {})
  assert.doesNotMatch(JSON.stringify(projection), /cache|security|allowed_directories/)
  const deleted: any = await f.execute('delete_video_job', { job_id })
  assert.equal(deleted.structuredContent.status, 'deleted')
  const missing: any = await f.execute('read_video_timeline', { job_id })
  assert.equal(missing.isError, true)
  for (const directory of await readdir(path.join(f.root, 'video'))) assert.deepEqual(await readdir(path.join(f.root, 'video', directory, 'input')), [])
})

test('live VideoContext accepts a workspace range and rejects damaged media without exporting paths', { skip: !available, timeout: 120000 }, async t => {
  const f = await videoFixture(); t.after(() => f.close())
  const filename = path.join(f.workspaceRoot, 'range.mp4'); await makeVideo(filename)
  await f.accept(Buffer.from('not a video'))
  const prepared: any = await f.execute('prepare_video', { source: { path: 'range.mp4' },
    range: { start_time_seconds: 6, end_time_seconds: 8 }, sampling: { mode: 'timestamps', timestamps_seconds: [7] } })
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared))
  const timeline: any = await f.execute('read_video_timeline', { job_id: prepared.structuredContent.job_id })
  assert.match(timeline.structuredContent.content, /F\t7000/)
  assert.doesNotMatch(timeline.structuredContent.content, /F\t1000/)
  const broken: any = await f.execute('inspect_video', { source: { attachment: (await f.accept(Buffer.from('broken'))).id } })
  assert.equal(broken.isError, true)
})
