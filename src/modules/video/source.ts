import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, copyFile, stat, rm } from 'node:fs/promises'
import { workspaceFile } from '@eden/execution'
import type { VideoSource } from '@eden/api'
import type { AttachmentRepository, AttachmentService } from '../attachments/index.ts'
import type { WorkspaceService, WorkspaceSnapshot } from '../workspace/index.ts'

const extensions = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm'])
function extension(filename: string) {
  const value = path.extname(filename).toLowerCase()
  if (!extensions.has(value)) throw new Error('视频格式需为 MP4、WebM、MOV、MKV、AVI、M4V 或 MPEG')
  return value
}
export interface VideoInputScope { sessionId: string; turnId: string; actorId?: string | number; qq: boolean; groupReadOnly: boolean }

export class VideoSources {
  constructor(private readonly repository: AttachmentRepository, private readonly attachments: AttachmentService) {}

  capture(source: VideoSource, scope: VideoInputScope, workspace: WorkspaceService) {
    if ('youtubeUrl' in source) {
      if (scope.groupReadOnly) throw new Error('此群未允许外部操作，不能下载在线视频')
      const url = new URL(source.youtubeUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname))
        throw new Error('在线视频目前只支持 HTTPS YouTube 链接')
      return { remote: source.youtubeUrl }
    }
    if ('attachment' in source) {
      const snapshot = this.repository.current(scope.sessionId, scope.turnId).find(value => value.blobId === source.attachment)
      if (!snapshot) throw new Error('当前输入中不存在这个视频附件')
      const fallback = ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv' } as Record<string, string>)[snapshot.mime]
      return { snapshot, extension: extension(snapshot.filename ?? `video${fallback ?? ''}`) }
    }
    if (scope.qq) throw new Error('QQ 视频工具仅接受当前视频附件或 YouTube 链接')
    const workspaceSnapshot = workspace.snapshot()
    return { filename: workspaceFile(workspaceSnapshot.root, source.path), requested: source.path, extension: extension(source.path), workspaceSnapshot }
  }

  async stage(captured: ReturnType<VideoSources['capture']>, directory: string, workspace: WorkspaceService, scope: VideoInputScope, signal: AbortSignal) {
    if ('remote' in captured) return { url: captured.remote! }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    const filename = path.join(directory, randomUUID() + captured.extension!)
    try {
      if (captured.snapshot) {
        const bytes = await this.attachments.read(captured.snapshot)
        this.repository.current(scope.sessionId, scope.turnId)
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 })
      } else {
        workspace.assertSnapshot(captured.workspaceSnapshot as WorkspaceSnapshot)
        if (workspaceFile(captured.workspaceSnapshot!.root, captured.requested!) !== captured.filename) throw new Error('视频路径在审批后改变')
        const before = await stat(captured.filename!)
        if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new Error('视频必须是小于 512 MiB 的普通文件')
        await copyFile(captured.filename!, filename)
        const after = await stat(captured.filename!)
        workspace.assertSnapshot(captured.workspaceSnapshot as WorkspaceSnapshot)
        if (workspaceFile(captured.workspaceSnapshot!.root, captured.requested!) !== captured.filename) throw new Error('视频路径在准备期间改变')
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('视频文件在准备期间改变，请重试')
      }
      signal.throwIfAborted()
      return { path: filename }
    } catch (error) { await rm(filename, { force: true }); throw error }
  }
}

export function videoScopeKey(sessionId: string, actorId?: string | number) {
  return createHash('sha256').update(JSON.stringify([sessionId, actorId === undefined ? null : String(actorId)])).digest('hex')
}
