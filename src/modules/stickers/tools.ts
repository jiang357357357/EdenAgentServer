import { z } from 'zod'
import { toJson, stickerListInputSchema, stickerSelectInputSchema, stickerRememberInputSchema, characterStickerSchema } from '@eden/api'
import type { JsonValue } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import type { MonBindingService, NapcatClient } from '../mon/index.ts'
import type { SessionRepository } from '../sessions/index.ts'
import type { PermissionService } from '../permissions/index.ts'
import type { AttachmentRepository, AttachmentService } from '../attachments/index.ts'
import { toolDescription, type BuiltinToolDescription } from '../../model-prompts/tool-descriptions.ts'
import { stickerImage, stickerImageUrl } from './image-source.ts'
import { stickerCatalog, selectSticker, searchStickers } from './catalog.ts'
import { stickerResult } from '../tool-results/index.ts'
import { StickerDelivery } from './delivery.ts'

type ToolContext = Parameters<RuntimeTool['execute']>[1]
type CharacterContext = ReturnType<MonBindingService['characterContext']>

export function stickerTools(mon: Pick<MonBindingService, 'characterContext'>, napcat: NapcatClient,
  repository: SessionRepository, permissions: PermissionService, attachmentRepository: AttachmentRepository,
  attachments: AttachmentService, sessionId: string, turnId: string, actorId?: string | number): RuntimeTool[] {
  const delivery = new StickerDelivery(repository, permissions, napcat, sessionId, turnId, actorId)
  const approve = async (context: ToolContext, character: CharacterContext, mode: 'read' | 'write', action: string, details: unknown) => {
    const assertCurrent = () => { context.assertCurrent?.(); character.assertCurrent() }
    assertCurrent()
    await permissions.request({ ...context, sessionId, turnId, assertCurrent }, `character.sticker.${mode}`,
      `character:${character.characterId}:${action}`, toJson({ action, characterId: character.characterId, ...details as object }))
    context.signal.throwIfAborted(); assertCurrent()
  }
  const tool = (name: BuiltinToolDescription, schema: z.ZodType, execute: RuntimeTool['execute']): RuntimeTool => ({
    name, revision: 'eden.character.stickers.v1', executionMode: 'sequential', description: toolDescription(name), modelResult: stickerResult,
    parameters: toJson(z.toJSONSchema(schema, { io: 'input' })) as Record<string, JsonValue>, execute,
  })
  return [tool('list_character_stickers', stickerListInputSchema, async (raw, context) => {
    const input = stickerListInputSchema.parse(raw), character = mon.characterContext(sessionId, actorId)
    await approve(context, character, 'read', 'list', input)
    const stickers = await stickerCatalog(character.client, character.characterId, context.signal)
    character.assertCurrent()
    return toJson({ stickers: searchStickers(stickers, input.query) })
  }), tool('remember_character_sticker', stickerRememberInputSchema, async (raw, context) => {
    const input = stickerRememberInputSchema.parse(raw), character = mon.characterContext(sessionId, actorId)
    await approve(context, character, 'write', 'save', input)
    const image = await stickerImage(input, attachmentRepository, attachments, sessionId, turnId, context.signal)
    character.assertCurrent(); context.assertCurrent?.()
    const form = new FormData()
    for (const key of ['name', 'description', 'emotion', 'intent'] as const) form.set(key, input[key])
    form.set('aliases', JSON.stringify(input.aliases))
    form.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `sticker.${image.mime.split('/')[1]}`)
    const sticker = characterStickerSchema.parse(await character.client.postMultipart(`/api/characters/${character.characterId}/stickers/`, form, context.signal))
    if (sticker.character_id !== character.characterId) throw new Error('Saved sticker belongs to another character')
    sticker.image_url = stickerImageUrl(sticker.image_url)
    return toJson({ saved: true, sticker })
  }), ...(['send', 'delete'] as const).map(action => tool(`${action}_character_sticker`, stickerSelectInputSchema, async (raw, context) => {
    const input = stickerSelectInputSchema.parse(raw), character = mon.characterContext(sessionId, actorId)
    await approve(context, character, 'write', action, input)
    const sticker = selectSticker(await stickerCatalog(character.client, character.characterId, context.signal), input.sticker)
    character.assertCurrent(); context.assertCurrent?.()
    if (action === 'send') return delivery.send(sticker, character, context,
      () => { context.assertCurrent?.(); character.assertCurrent() })
    await character.client.delete(`/api/characters/${character.characterId}/stickers/${sticker.id}/`, context.signal)
    return toJson({ deleted: true, sticker })
  }))]
}
