import { z } from 'zod'
import { toJson, characterStickerSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'

/** Platform receipts are kept only in durable tool audit, including during history restoration. */
export function stickerResult(value: JsonValue): JsonValue {
  return toJson(z.object({ stickers: z.array(characterStickerSchema).optional(), sticker: characterStickerSchema.optional(),
    saved: z.boolean().optional(), deleted: z.boolean().optional(), channel: z.enum(['app', 'qq']).optional(),
    status: z.enum(['success', 'failed', 'unknown']).optional() }).parse(value))
}
