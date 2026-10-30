import { STICKER_MAX_BYTES } from '@eden/api'
import type { AttachmentService, AttachmentRepository } from '../attachments/index.ts'
import { imageMime, assertImageSignature } from '../attachments/index.ts'

export function stickerImageUrl(source: string): string {
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Sticker images require an HTTP(S) URL without credentials or a fragment')
  return url.href
}

export async function downloadStickerImage(source: string, signal: AbortSignal) {
  const response = await fetch(stickerImageUrl(source), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: 'error',
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Sticker image download failed: HTTP ${response.status}`) }
  const mime = imageMime(response.headers.get('content-type') ?? '')
  if (!mime || Number(response.headers.get('content-length')) > STICKER_MAX_BYTES) {
    await response.body?.cancel(); throw new Error('Sticker must be a PNG, JPEG, GIF or WebP image of at most 10 MiB')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Sticker image is empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > STICKER_MAX_BYTES) throw new Error('Sticker image exceeds 10 MiB')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return { bytes: Buffer.concat(chunks), mime }
}

export async function stickerImage(input: { blobId?: string | undefined; imageUrl?: string | undefined },
  repository: AttachmentRepository, attachments: AttachmentService, sessionId: string, turnId: string, signal: AbortSignal) {
  signal.throwIfAborted()
  let image
  if (input.blobId) {
    const snapshot = repository.current(sessionId, turnId).find(item => item.blobId === input.blobId)
    if (!snapshot || snapshot.kind !== 'image') throw new Error('Choose an image attachment from the current input')
    if (snapshot.byteLength > STICKER_MAX_BYTES) throw new Error('Sticker image exceeds 10 MiB')
    image = { bytes: await attachments.read(snapshot), mime: imageMime(snapshot.mime)! }
    repository.current(sessionId, turnId)
  } else image = await downloadStickerImage(input.imageUrl!, signal)
  signal.throwIfAborted()
  if (!image.bytes.length || image.bytes.length > STICKER_MAX_BYTES) throw new Error('Sticker image is empty or exceeds 10 MiB')
  assertImageSignature(image.bytes, image.mime)
  return image
}
