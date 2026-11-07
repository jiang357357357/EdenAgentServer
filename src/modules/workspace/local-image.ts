import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeImage } from '@eden/runtime-pi'
import { assertImageSignature } from '../attachments/index.ts'

// Bound both the private audit receipt and the native image input.
const maxBytes = 6 * 1024 * 1024
const formats: RuntimeImage['mimeType'][] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function imageFormat(bytes: Buffer): RuntimeImage['mimeType'] {
  for (const mime of formats) {
    try { assertImageSignature(bytes, mime); return mime }
    catch { /* Try the next supported file signature, regardless of its extension. */ }
  }
  throw new Error('图片格式不支持或文件头损坏；支持 PNG、JPEG、WebP、GIF')
}

/** Read a bounded, stable file snapshot; image bytes never become ordinary model text. */
export async function readLocalImage(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1 || before.size > maxBytes)
      throw new Error('图片必须是大于 0 且不超过 6 MiB 的普通文件')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, offset, Math.min(262144, buffer.length - offset), offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    signal.throwIfAborted()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw new Error('图片在读取期间发生变化，请重新读取')
    const bytes = buffer.subarray(0, offset), mime = imageFormat(bytes)
    return { name: path.basename(filename), path: filename, mime, byteLength: bytes.length,
      content: [{ type: 'image', mimeType: mime, data: bytes.toString('base64') }] }
  } finally { await file.close() }
}
