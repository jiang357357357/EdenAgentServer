import { createHash } from 'node:crypto'
import { bridgeHttp, readNdjson } from '@eden/plugin-sdk/connector'
import type { ConnectorDefinition, ConnectorContext } from '@eden/plugin-sdk/connector'
import { jsonValue } from '@eden/api/connector'
import type { JsonValue } from '@eden/api/connector'
import { actionRequest } from './actions.ts'
import { position, object } from './position.ts'

const actions = ['accept_challenge', 'decline_challenge', 'make_move', 'resign', 'offer_draw', 'send_chat']
export const connector: ConnectorDefinition = { id: 'lichess', version: '2.0.0', events: ['challenge', 'game_state'], queries: [], actions, initialize }

function initialize(context: ConnectorContext) {
  const base = String(object(context.settings).baseUrl ?? 'https://lichess.org').replace(/\/$/, '')
  const credential = process.env.MON_CONNECTOR_IDENTITY_CREDENTIAL, identity = process.env.MON_CONNECTOR_IDENTITY_KEY
  if (!credential || !identity) throw new Error('Private connector identity is missing')
  const abort = new AbortController(), signal = AbortSignal.any([context.signal, abort.signal])
  const headers = { Authorization: `Bearer ${credential}` }, games = new Map<string, Promise<void>>()
  let ready = false, failed = false
  const fail = () => { if (!signal.aborted) { failed = true; context.status('degraded'); abort.abort() } }
  const startGame = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid game ID')
    if (games.has(id)) return
    if (games.size >= 16) throw new Error('Too many concurrent game streams')
    const task = streamGame(id, base, identity, headers, context, signal).catch(fail).finally(() => games.delete(id))
    games.set(id, task)
  }
  const account = (async () => {
    const response = await bridgeHttp(new URL(base + '/api/stream/event'), 'GET', headers, signal)
    ready = true; context.status('ready')
    for await (const raw of readNdjson(response)) {
      const payload = object(jsonValue.parse(raw)), kind = String(payload.type ?? '')
      if (kind.startsWith('challenge')) context.publish('challenge', stableId('account', payload), payload)
      const game = object(payload.game)
      if (kind === 'gameStart' && typeof game.id === 'string') startGame(game.id)
    }
    if (!signal.aborted) throw new Error('Account event stream ended')
  })().catch(fail)
  return {
    health: () => ({ state: failed ? 'degraded' as const : ready ? 'ready' as const : 'connecting' as const, initialized: true }),
    async execute(call: { capability: string; payload: JsonValue }) {
      const action = actionRequest(call.capability, call.payload)
      const response = await bridgeHttp(new URL(base + action.path), 'POST', { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, AbortSignal.any([signal, AbortSignal.timeout(30000)]), action.form.toString())
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of response) { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); throw new Error('Action response too large') }; chunks.push(Buffer.from(chunk)) }
      const raw = Buffer.concat(chunks).toString('utf8')
      let result: JsonValue = raw
      try { result = jsonValue.parse(JSON.parse(raw)) } catch { /* Plain text responses remain text. */ }
      return { ok: true, status: response.statusCode!, result }
    },
    async close() { abort.abort(); await account; await Promise.allSettled(games.values()) }
  }
}
async function streamGame(id: string, base: string, identity: string, headers: Record<string, string>, context: ConnectorContext, signal: AbortSignal) {
  const response = await bridgeHttp(new URL(base + `/api/bot/game/stream/${id}`), 'GET', headers, signal)
  let full: Record<string, JsonValue> = {}
  for await (const raw of readNdjson(response)) {
    const state = object(jsonValue.parse(raw))
    if (state.type === 'gameFull') full = state
    if (state.type === 'gameState') full.state = state
    const payload = { game_id: id, raw: state, position: position(id, identity, full, state) }
    context.publish('game_state', stableId(`game:${id}`, payload), payload)
  }
}
export function stableId(prefix: string, value: Record<string, JsonValue>) {
  if (typeof value.id === 'string' && value.id) return `${prefix}:${value.id}`
  return `${prefix}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`
}
