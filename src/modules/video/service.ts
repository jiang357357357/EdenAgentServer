import path from 'node:path'
import { rm } from 'node:fs/promises'
import { toJson, type JsonValue } from '@eden/api'
import type { WorkspaceService } from '../workspace/index.ts'
import type { VideoBackend } from './backend.ts'
import { VideoSources, videoScopeKey, type VideoInputScope } from './source.ts'

export class VideoService {
  constructor(private readonly root: string, private readonly backend: VideoBackend, private readonly sources: VideoSources) {}

  capture(source: Parameters<VideoSources['capture']>[0], scope: VideoInputScope, workspace: WorkspaceService) {
    return this.sources.capture(source, scope, workspace)
  }

  async prepare(operation: 'inspect' | 'prepare', captured: ReturnType<VideoSources['capture']>, parameters: Record<string, unknown>,
    scope: VideoInputScope, workspace: WorkspaceService, signal: AbortSignal, assertCurrent: () => void) {
    const directory = this.directory(scope)
    const source = await this.sources.stage(captured, path.join(directory, 'input'), workspace, scope, signal)
    try {
      signal.throwIfAborted(); assertCurrent()
      const result = await this.backend.call(directory, `${operation}_${'url' in source ? 'youtube' : 'local'}_video`,
        toJson({ ...source, ...parameters }), signal)
      if ('path' in source) restoreSourceName(result, captured.snapshot?.filename ?? path.basename(captured.filename ?? 'video.mp4'))
      return result
    } finally { if ('path' in source && source.path) await rm(source.path, { force: true }) }
  }

  call(scope: VideoInputScope, name: string, input: JsonValue, signal: AbortSignal) {
    return this.backend.call(this.directory(scope), name, input, signal)
  }
  private directory(scope: VideoInputScope) { return path.join(this.root, videoScopeKey(scope.sessionId, scope.actorId)) }
  close() { return this.backend.close() }
}

function restoreSourceName(result: JsonValue, filename: string) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return
  const body = result.structuredContent
  if (!body || typeof body !== 'object' || Array.isArray(body)) return
  const source = body.source
  if (source && typeof source === 'object' && !Array.isArray(source)) source.display_title_or_filename = filename
  // FastMCP repeats structured output in a text block. Keep that copy consistent.
  if (Array.isArray(result.content)) result.content = result.content.map(item =>
    item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text'
      ? { ...item, text: JSON.stringify(body) } : item)
}
