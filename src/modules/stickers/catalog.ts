import { characterStickerSchema } from '@eden/api'
import type { CharacterSticker } from '@eden/api'
import type { MonClient } from '@eden/integrations'
import { stickerImageUrl } from './image-source.ts'

export async function stickerCatalog(client: MonClient, characterId: number, signal: AbortSignal): Promise<CharacterSticker[]> {
  const values = await client.getCollection(`/api/characters/${characterId}/stickers/?enabled=true`, signal)
  return values.map(value => {
    const sticker = characterStickerSchema.parse(value)
    if (sticker.character_id !== characterId) throw new Error('Core returned a sticker belonging to another character')
    sticker.image_url = stickerImageUrl(sticker.image_url)
    return sticker
  }).filter(item => item.enabled)
}

export function selectSticker(stickers: CharacterSticker[], selector: string): CharacterSticker {
  const query = selector.toLocaleLowerCase()
  const byId = stickers.find(item => String(item.id) === selector)
  if (byId) return byId
  const matches = stickers.filter(item => [item.name, ...item.aliases].some(value => value.toLocaleLowerCase() === query))
  if (!matches.length) throw new Error('Character sticker was not found; list available stickers first')
  if (matches.length > 1) throw new Error('Sticker alias is ambiguous; choose its ID from the catalog')
  return matches[0]!
}

export function searchStickers(stickers: CharacterSticker[], query: string): CharacterSticker[] {
  const value = query.toLocaleLowerCase()
  return stickers.filter(item => [item.name, item.description, item.emotion, item.intent, ...item.aliases]
    .some(text => text.toLocaleLowerCase().includes(value)))
}
