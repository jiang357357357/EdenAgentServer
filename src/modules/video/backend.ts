import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { JsonValue } from '@eden/api'
import { callVideoWorker } from './worker.ts'

declare const EDEN_BUNDLED_SERVER: boolean
const resources = typeof EDEN_BUNDLED_SERVER !== 'undefined' && EDEN_BUNDLED_SERVER
  ? fileURLToPath(new URL('./video-context/', import.meta.url))
  : fileURLToPath(new URL('../../../resources/video-context/', import.meta.url))
export function defaultVideoRuntimeRoot() {
  const bundled = path.resolve(resources, '../video-runtime')
  return existsSync(path.join(bundled, 'runtime.json')) ? bundled : path.resolve(resources, '../../../Data/runtime/video-context')
}
const manifestSchema = z.object({ version: z.literal(1), python: z.string().min(1), ffmpeg: z.string().min(1),
  ffprobe: z.string().min(1), model: z.enum(['tiny', 'base', 'small', 'medium', 'large-v3']) })
export interface VideoBackend {
  call(scope: string, name: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue>
  close(): Promise<void>
}

/** Every call gets a bounded worker. Persistent jobs live in the owning scope. */
export class VideoContextBackend implements VideoBackend {
  private readonly active = new Set<AbortController>()
  private readonly activeScopes = new Set<string>()
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false
  constructor(private readonly runtime: string) {}

  call(scope: string, name: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new Error('视频服务已关闭'))
    // Each fresh worker cleans its scope's abandoned staging directory on startup.
    // Never start a second worker over an actively processing scope.
    if (this.active.size >= 2 || this.activeScopes.has(scope)) return Promise.reject(new Error('视频处理暂忙，请稍后重试'))
    const controller = new AbortController()
    this.active.add(controller)
    this.activeScopes.add(scope)
    const task = this.execute(scope, name, input, AbortSignal.any([signal, controller.signal]))
      .finally(() => { this.active.delete(controller); this.activeScopes.delete(scope); this.pending.delete(task) })
    this.pending.add(task)
    return task
  }

  private async execute(scope: string, name: string, input: JsonValue, signal: AbortSignal) {
    signal.throwIfAborted()
    let manifest: z.infer<typeof manifestSchema>
    try { manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(this.runtime, 'runtime.json'), 'utf8'))) }
    catch (error) { throw new Error('视频运行时未安装或配置损坏；请运行 npm run setup:video（详见开发与运行文档）', { cause: error }) }
    if (name.startsWith('prepare_') && input && typeof input === 'object' && !Array.isArray(input)) {
      const transcript = input.transcript && typeof input.transcript === 'object' && !Array.isArray(input.transcript) ? input.transcript : {}
      input = { ...input, transcript: { ...transcript, model: manifest.model } }
    }
    await mkdir(path.join(scope, 'input'), { recursive: true, mode: 0o700 })
    return callVideoWorker({ python: path.resolve(this.runtime, manifest.python), entry: path.join(resources, 'eden_entry.py'),
      runtime: this.runtime, scope, name, input, signal })
  }

  async close() {
    this.closed = true
    for (const controller of this.active) controller.abort()
    await Promise.allSettled([...this.pending])
  }
}
