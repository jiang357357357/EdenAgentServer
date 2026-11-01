import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { runProcess } from '@eden/execution'
import { toJson } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { AttachmentRepository, AttachmentService } from '../../../src/modules/attachments/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { VideoService, VideoSources, VideoContextBackend, defaultVideoRuntimeRoot, videoTools } from '../../../src/modules/video/index.ts'
import type { VideoBackend } from '../../../src/modules/video/backend.ts'
import { modelTool } from '../../../src/modules/tool-results/index.ts'

export const runtimeRoot = process.env.EDEN_AGENT_VIDEO_RUNTIME_ROOT ?? defaultVideoRuntimeRoot()
export async function videoFixture(backend: VideoBackend = new VideoContextBackend(runtimeRoot), channel: 'app' | 'qq' | 'group' = 'app') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-video-'))
  const workspaceRoot = path.join(root, 'workspace'); await mkdir(workspaceRoot)
  const origin = channel === 'app' ? 'local' : 'mon'
  const db = new EdenDatabase(':memory:', origin)
  const sessions = new SessionRepository(db, origin), inputs = new InputRepository(db, sessions.events)
  const session = sessions.create('视频测试', channel === 'app' ? [] : [{ assistantId: 1 }], null, { purpose: 'user_chat', sourceChannel: channel === 'app' ? 'app' : 'qq' })
  if (channel === 'group') db.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)').run(session.id, '111111', '333333', '222222', 0, Date.now())
  if (channel === 'qq') db.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)').run('111111', '222222', session.id, Date.now())
  const permissions = new PermissionService(db, sessions.events)
  permissions.setMode('takeover'); permissions.setQqMode('111111', '222222', 'takeover')
  if (channel === 'group') permissions.setQqMode('111111', '222222', 'takeover', '333333')
  const workspace = new WorkspaceService(db, [], workspaceRoot)
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(db))
  const attachments = new AttachmentService(blobs), repository = new AttachmentRepository(db)
  const service = new VideoService(path.join(root, 'video'), backend, new VideoSources(repository, attachments))
  let active: ReturnType<InputRepository['claim']>
  const scope = (actorId?: string | number) => ({ sessionId: session.id, turnId: active!.turnId, qq: channel !== 'app', ...(actorId === undefined ? {} : { actorId }) })
  const tools = (actorId?: string | number) => videoTools(service, permissions, workspace, scope(actorId)).map(modelTool)
  return { root, db, sessions, session, inputs, workspace, workspaceRoot, blobs, attachments, permissions, service, tools,
    async accept(bytes: Buffer, filename = 'video.mp4', mime = 'video/mp4') {
      if (active) inputs.finish(active)
      const blob = await blobs.put(bytes, mime), snapshots = await attachments.snapshot([{ blobId: blob.id, filename, mime }])
      inputs.enqueue(session.id, '查看视频', randomUUID(), toJson({ attachments: snapshots })); active = inputs.claim(session.id)
      return blob
    },
    next() { if (active) inputs.finish(active); inputs.enqueue(session.id, '继续查看', randomUUID()); active = inputs.claim(session.id) },
    async execute(name: string, input: Record<string, unknown>, actorId?: string | number, signal = AbortSignal.timeout(180000)) {
      const tool = tools(actorId).find(value => value.name === name)!
      return tool.execute(input, { callId: randomUUID(), signal })
    },
    async close() { await service.close(); db.close(); await rm(root, { recursive: true, force: true }) },
  }
}

export async function makeVideo(filename: string) {
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime.json'), 'utf8'))
  const colors = ['red', 'green', 'blue', 'yellow']
  const inputs = colors.flatMap(color => ['-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=5:d=2`])
  const result = await runProcess({ executable: path.join(runtimeRoot, manifest.ffmpeg),
    args: ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=8',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-map', '4:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', filename],
    input: '', timeoutMs: 30000, maxOutputBytes: 32768 })
  if (result.exitCode !== 0) throw new Error(result.stderr)
}
