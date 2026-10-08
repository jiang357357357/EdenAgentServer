import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { healthHandler } from '../../../src/transport/http/health.ts'

test('a failed session remains diagnostic and does not mark its peers offline', async t => {
  let accounts = true
  const server = createServer(healthHandler('local', () => ({ model: true, sessionFaults: 1, memoryExtraction: true, accounts })))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}/readyz`
  const response = await fetch(endpoint)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { checks: { sessionFaults: number } }).checks.sessionFaults, 1)
  accounts = false
  assert.equal((await fetch(endpoint)).status, 503, 'actual host/account failure still affects readiness')
})
