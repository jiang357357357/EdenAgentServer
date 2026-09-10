import { Chess } from 'chess.js'
import type { JsonValue } from '@eden/api/connector'

export function object(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
export function position(gameId: string, identity: string, full: Record<string, JsonValue>, latest: Record<string, JsonValue>) {
  const state = object(latest.type === 'gameState' ? latest : full.state)
  const moves = text(state.moves).trim().split(/\s+/).filter(Boolean), initial = text(full.initialFen, 'startpos')
  const variant = text(object(full.variant).key ?? object(full.variant).name, 'standard')
  const player = (raw: unknown) => { const value = object(raw); return { id: text(value.id ?? value.name), rating: value.rating ?? null, title: value.title ?? null } }
  const white = player(full.white), black = player(full.black)
  const bot = white.id.toLowerCase() === identity.toLowerCase() ? 'white' : black.id.toLowerCase() === identity.toLowerCase() ? 'black' : null
  const side = moves.length % 2 === 0 ? 'white' : 'black'
  const result: Record<string, JsonValue> = { game_id: gameId, variant, initial_fen: initial, moves_uci: moves, ply: moves.length,
    side_to_move: side, bot_color: bot, is_bot_turn: bot === side, white, black, status: state.status ?? 'started', winner: state.winner ?? null,
    white_time_ms: state.wtime ?? null, black_time_ms: state.btime ?? null, white_increment_ms: state.winc ?? null, black_increment_ms: state.binc ?? null,
    draw_offer_by_white: state.wdraw === true, draw_offer_by_black: state.bdraw === true }
  try { Object.assign(result, replayPosition(variant, initial, moves, bot)) }
  catch { Object.assign(result, { position_valid: false, position_error: 'Unsupported variant or invalid position/move history', legal_moves_uci: [] }) }
  return result
}
function replayPosition(variant: string, initial: string, moves: string[], bot: string | null) {
  if (!['standard', 'fromPosition'].includes(variant)) throw new Error('Unsupported variant')
  const chess = initial === 'startpos' ? new Chess() : new Chess(initial)
  for (const move of moves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error('Invalid UCI move')
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) })
  }
  const side = chess.turn() === 'w' ? 'white' : 'black'
  return { fen: chess.fen(), legal_moves_uci: chess.moves({ verbose: true }).map(move => move.from + move.to + (move.promotion ?? '')),
    check: chess.isCheck(), checkmate: chess.isCheckmate(), stalemate: chess.isStalemate(), position_valid: true, side_to_move: side, is_bot_turn: bot === side }
}
