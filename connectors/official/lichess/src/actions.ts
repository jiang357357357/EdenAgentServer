import { z } from 'zod'
import type { JsonValue } from '@eden/api/connector'

const segment = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128)
const schemas = {
  accept_challenge: z.object({ challenge_id: segment }).strict(),
  decline_challenge: z.object({ challenge_id: segment, reason: z.enum(['generic', 'later', 'tooFast', 'tooSlow', 'timeControl', 'rated', 'casual', 'standard', 'variant', 'noBot', 'onlyBot']).default('generic') }).strict(),
  make_move: z.object({ game_id: segment, move: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/), offer_draw: z.boolean().default(false) }).strict(),
  resign: z.object({ game_id: segment }).strict(), offer_draw: z.object({ game_id: segment }).strict(),
  send_chat: z.object({ game_id: segment, text: z.string().min(1).max(1000), room: z.enum(['player', 'spectator']).default('player') }).strict()
}
export function actionRequest(action: string, payload: JsonValue): { path: string; form: URLSearchParams } {
  if (action === 'accept_challenge') return { path: `/api/challenge/${schemas.accept_challenge.parse(payload).challenge_id}/accept`, form: new URLSearchParams() }
  if (action === 'decline_challenge') {
    const input = schemas.decline_challenge.parse(payload)
    return { path: `/api/challenge/${input.challenge_id}/decline`, form: new URLSearchParams({ reason: input.reason }) }
  }
  if (action === 'make_move') {
    const input = schemas.make_move.parse(payload)
    return { path: `/api/bot/game/${input.game_id}/move/${input.move}`, form: new URLSearchParams({ offeringDraw: String(input.offer_draw) }) }
  }
  if (action === 'resign' || action === 'offer_draw') {
    const input = schemas[action].parse(payload)
    return { path: `/api/bot/game/${input.game_id}/${action === 'resign' ? 'resign' : 'draw/yes'}`, form: new URLSearchParams() }
  }
  if (action === 'send_chat') {
    const input = schemas.send_chat.parse(payload)
    return { path: `/api/bot/game/${input.game_id}/chat`, form: new URLSearchParams({ room: input.room, text: input.text }) }
  }
  throw new Error('Unknown Lichess action')
}
