import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { position } from '../connectors/official/lichess/src/position.ts'
import { actionRequest } from '../connectors/official/lichess/src/actions.ts'
import { officialConnectorFixture } from './official-connector-fixture.ts'

test('Lichess UCI replay exposes legal positions and action paths reject injection', () => {
  const full = { initialFen: 'startpos', variant: { key: 'standard' }, white: { id: 'agent' }, black: { id: 'other' }, state: { moves: 'e2e4 e7e5 g1f3' } }
  const result = position('game1', 'agent', full, { type: 'gameFull' })
  assert.equal(result.position_valid, true); assert.equal(result.side_to_move, 'black'); assert.equal(result.is_bot_turn, false)
  assert.ok((result.legal_moves_uci as string[]).includes('b8c6'))
  assert.equal(actionRequest('resign', { game_id: 'game1' }).path, '/api/bot/game/game1/resign')
  assert.throws(() => actionRequest('resign', { game_id: '../escape' }))
  assert.throws(() => actionRequest('make_move', { game_id: 'a', move: '0000' }))
  assert.equal(position('g', 'agent', { ...full, variant: { key: 'atomic' } }, {}).position_valid, false)
})

test('real Lichess worker streams through approved local HTTP bridge and sends a scoped action', async t => {
  const requests: { path: string; authorization: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ path: request.url!, authorization: request.headers.authorization, body })
      if (request.url === '/api/stream/event') {
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        response.write(JSON.stringify({ type: 'challenge', challenge: { id: 'test-1' } }) + '\n')
      } else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}') }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address() as { port: number }
  const f = await officialConnectorFixture(t, 'lichess', { baseUrl: `http://127.0.0.1:${address.port}` }, 'fixture-secret')
  for (let attempt = 0; attempt < 30; attempt++) {
    if (f.database.connection.prepare('SELECT 1 FROM connector_events WHERE connector_id=?').get(f.instance.id)) break
    await delay(100)
  }
  assert.ok(f.database.connection.prepare('SELECT 1 FROM connector_events WHERE connector_id=?').get(f.instance.id))
  assert.deepEqual(await f.launched.runtime.invoke('execute', 'make_move', { game_id: 'game1', move: 'e2e4', offer_draw: false }, 'move-1', f.signal), { ok: true, status: 200, result: { ok: true } })
  assert.ok(requests.some(item => item.path === '/api/bot/game/game1/move/e2e4' && item.authorization === 'Bearer fixture-secret' && item.body === 'offeringDraw=false'))
  const publicEvents = f.database.connection.prepare('SELECT payload_json FROM connector_events').all()
  assert.ok(!JSON.stringify(publicEvents).includes('fixture-secret'))
})
