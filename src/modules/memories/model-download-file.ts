import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MemoryModelDownload } from './model-download-spec.ts'

export async function downloadModelFile(root: string, spec: MemoryModelDownload, file: MemoryModelDownload['files'][number],
  signal: AbortSignal, progress: (bytes: number) => void, fetcher: typeof fetch): Promise<void> {
  const target = path.resolve(root, file.path)
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('模型文件路径无效。')
  const response = await fetcher(new URL(file.path, spec.baseUrl), { signal, redirect: 'follow' })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`模型下载失败（HTTP ${response.status}），请检查网络后重试。`)
  }
  await mkdir(path.dirname(target), { recursive: true })
  const digest = createHash('sha256')
  let received = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    received += chunk.length
    if (received > file.bytes) { done(new Error('模型下载大小与固定版本不符。')); return }
    digest.update(chunk); progress(chunk.length); done(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter,
    createWriteStream(target, { flags: 'wx' }), { signal })
  if (received !== file.bytes || digest.digest('hex') !== file.sha256) throw new Error('模型文件校验失败，请重试下载。')
}
