import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EdenDatabase } from '@eden/store'
import { MonHttpError } from '@eden/integrations'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { MonClientFactory } from '../../../src/modules/mon/client-factory.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'

test('persisted service sessions renew under the same owner, browser bindings and foreign runtimes cannot borrow identity', async t => {
  let exchanges = 0, token = '', invalidated = false
  const server = createServer((request, response) => {
    if (request.url === '/api/users/me/profile/') {
      response.end(JSON.stringify({ id: request.headers.authorization === 'Token browser-seven' ? 7 : 8 })); return
    }
    if (request.url === '/api/internal/service-token/') {
      token = `service-${++exchanges}`; invalidated = false
      response.end(JSON.stringify({ user_id: '7', token, expires_in: 1200 })); return
    }
    if (request.headers.authorization !== `Token ${token}` || invalidated) {
      response.writeHead(401).end(JSON.stringify({ detail: 'expired test credential' })); return
    }
    response.end(JSON.stringify({ ok: true }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, identity = { coreBaseUrl: base, secret: 'fixture', userId: '7' }
  const account = { key: accountKey(base, '7'), coreBaseUrl: base, userId: '7' }
  const db = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(db, 'mon'), connections = new MonConnectionRepository(db)
  const service = withAccount(account, () => sessions.create('old QQ service', [{ assistantId: 5, characterId: 9 }], null, { purpose: 'user_chat', sourceChannel: 'qq' }))
  const browser = withAccount(account, () => sessions.create('browser'))
  const foreign = withAccount({ ...account, key: accountKey(base, '8'), userId: '8' }, () => sessions.create('another account QQ', [{ assistantId: 5, characterId: 9 }], null, { purpose: 'user_chat', sourceChannel: 'qq' }))
  const connection = { coreBaseUrl: base, coreToken: 'expired' }
  db.transaction(() => { for (const session of [service, browser, foreign]) connections.saveInTransaction(session.id, connection) })
  const renewed: string[] = []
  const factory = new MonClientFactory(sessions, identity, account, (_id, _base, _previous, next) => { renewed.push(next) })
  t.after(async () => { factory.close(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const client = factory.create(service.id, connection)
  await factory.validateConnection({ ...connection, coreToken: 'browser-seven' }, new AbortController().signal)
  await assert.rejects(factory.validateConnection({ ...connection, coreToken: 'browser-eight' }, new AbortController().signal), /another account/)
  await assert.rejects(factory.validateConnection({ ...connection, coreBaseUrl: 'http://127.0.0.1:1' }, new AbortController().signal), /another account endpoint/)
  assert.throws(() => db.transaction(() => factory.bindService(foreign.id, connection, true)), /another account/)
  await client.get('/api/check/'); assert.equal(exchanges, 1); assert.equal(connections.read(service.id)!.coreToken, 'service-1')
  invalidated = true; await client.get('/api/check/'); assert.equal(exchanges, 2); assert.deepEqual(renewed, ['service-1', 'service-2'])
  await assert.rejects(factory.create(browser.id, connection).get('/api/check/'), error => error instanceof MonHttpError && error.status === 401)
  await assert.rejects(factory.create(foreign.id, connection).get('/api/check/'), error => error instanceof MonHttpError && error.status === 401)
  assert.equal(exchanges, 2)
  db.transaction(() => { connections.saveInTransaction(service.id, connection); factory.bindService(service.id, connection, false) })
  factory.close()
  const restarted = new MonClientFactory(sessions, identity, account)
  try { await assert.rejects(restarted.create(service.id, connection).get('/api/check/'), error => error instanceof MonHttpError && error.status === 401) }
  finally { restarted.close() }
  assert.equal(exchanges, 2); assert.doesNotMatch(JSON.stringify(sessions.events.list(service.id)), /service-[12]|expired/)
})
