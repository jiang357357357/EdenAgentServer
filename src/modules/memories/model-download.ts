import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryModelStatus } from '@eden/api'
import { downloadModelFile } from './model-download-file.ts'
import { memoryModelDownload } from './model-download-spec.ts'
import type { MemoryModelDownload } from './model-download-spec.ts'

/** Download only after an explicit user action; inference never starts a download. */
export class LocalMemoryModel {
  private state: MemoryModelStatus['state'] = 'missing'
  private downloadedBytes = 0
  private error: string | null = null
  private active: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  private readonly totalBytes: number
  constructor(readonly modelPath: string, private readonly spec: MemoryModelDownload = memoryModelDownload, private readonly fetcher: typeof fetch = fetch) {
    this.modelPath = path.resolve(modelPath)
    this.totalBytes = spec.files.reduce((total, file) => total + file.bytes, 0)
  }

  status(): MemoryModelStatus {
    const ready = ['config.json', '1_Pooling/config.json', 'tokenizer.json', 'model.safetensors'].every(name => existsSync(path.join(this.modelPath, name)))
    const state = ready && !this.active ? 'ready' : this.state === 'ready' ? 'missing' : this.state
    return { model: 'bge-small-zh-v1.5', path: this.modelPath, state,
      downloadedBytes: ready && !this.active ? this.totalBytes : this.downloadedBytes, totalBytes: this.totalBytes, error: this.error }
  }

  download(): MemoryModelStatus {
    if (this.closed) throw new Error('模型下载服务已关闭。')
    if (this.active || this.status().state === 'ready') return this.status()
    if (existsSync(this.modelPath)) throw new Error('模型目录已存在但不完整，请整理该目录后重试，或指定一个空目录。')
    this.controller = new AbortController()
    this.state = 'downloading'; this.error = null; this.downloadedBytes = 0
    this.active = this.install(AbortSignal.any([this.controller.signal, AbortSignal.timeout(600000)]))
      .then(() => { this.state = 'ready' })
      .catch(error => {
        this.state = this.controller?.signal.aborted ? 'cancelled' : 'error'
        this.error = this.state === 'cancelled' ? null : downloadError(error)
      }).finally(() => { this.active = undefined; this.controller = undefined })
    return this.status()
  }

  private async install(signal: AbortSignal): Promise<void> {
    await mkdir(path.dirname(this.modelPath), { recursive: true })
    const staging = await mkdtemp(this.modelPath + '.download-')
    try {
      for (const file of this.spec.files) {
        signal.throwIfAborted()
        await downloadModelFile(staging, this.spec, file, signal, bytes => { this.downloadedBytes += bytes }, this.fetcher)
      }
      signal.throwIfAborted()
      await writeFile(path.join(staging, 'download.json'), JSON.stringify(this.spec, null, 2))
      // Refuse to overwrite a directory created while the download was running.
      if (existsSync(this.modelPath)) throw new Error('模型目标目录已被其他操作创建，请检查后重试。')
      await rename(staging, this.modelPath)
    } finally {
      if (path.dirname(staging) !== path.dirname(this.modelPath) || !path.basename(staging).startsWith(path.basename(this.modelPath) + '.download-')) throw new Error('模型临时目录校验失败。')
      await rm(staging, { recursive: true, force: true })
    }
  }

  async cancel(): Promise<MemoryModelStatus> { this.controller?.abort(); await this.active; return this.status() }
  async waitForIdle(): Promise<void> { await this.active }
  async close(): Promise<void> { this.closed = true; await this.cancel() }
}

function downloadError(error: unknown): string {
  if (error instanceof Error && /模型|HTTP/.test(error.message)) return error.message
  return '模型下载失败，请检查网络、磁盘空间后重试。'
}
