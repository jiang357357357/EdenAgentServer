import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { serviceSignature } from '@eden/integrations'
import type { SelfAwakeBridge } from '../../../src/modules/self-awake/index.ts'
import { SelfAwakeHttp } from '../../../src/transport/http/self-awake.ts'
import { configureLogging, loggingFile } from '../../../src/modules/logging/index.ts'

test('self-awake HTTP keeps signature and nonce failures closed with distinct diagnostics', async t => {
  const consumed = new Set<string>()
  let submissions = 0
  const secret = 'isolated-test-service-secret'
  const logRoot = await mkdtemp(path.join(tmpdir(), 'eden-self-awake-log-'))
  const loggingOptions = { origin: 'mon' as const, dataRoot: logRoot, env: {} }
  const logging = configureLogging(loggingOptions)
  t.after(async () => {
    logging.close()
    assert.ok(path.dirname(logRoot) === path.resolve(tmpdir()) && path.basename(logRoot).startsWith('eden-self-awake-log-'))
    await rm(logRoot, { recursive: true, force: true })
  })
  const bridge = {
    identity: { secret },
    repository: {
      consumeNonce(nonce: string) {
        if (nonce === 'capacity') throw new Error('Service nonce capacity reached')
        if (nonce === 'storage') throw new Error('Database unavailable')
        if (consumed.has(nonce)) throw Object.assign(new Error('Duplicate nonce'), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
        consumed.add(nonce)
      },
    },
    async submit() { submissions += 1; return { accepted: true } },
    async close() {},
  } as unknown as SelfAwakeBridge
  const handler = new SelfAwakeHttp('mon', bridge)
  const server = createServer((request, response) => {
    if (!handler.handle(request, response)) response.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await handler.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const route = '/internal/self-awake/run'
  const body = Buffer.from('{}')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`
  const send = async (nonce: string, timestamp = String(Math.floor(Date.now() / 1000)), validSignature = true) => {
    const signature = serviceSignature(secret, 'monos', 'self_awake:submit', timestamp, nonce, route, body)
    return fetch(url, { method: 'POST', body: '{}', headers: {
      'x-mon-service-id': 'monos', 'x-mon-service-scope': 'self_awake:submit',
      'x-mon-service-timestamp': timestamp, 'x-mon-service-nonce': nonce,
      'x-mon-service-signature': validSignature ? signature : '0'.repeat(64),
    } })
  }
  const accepted = await send('fresh')
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { accepted: true })
  for (const [nonce, timestamp, validSignature] of [
    ['fresh', undefined, true], ['capacity', undefined, true], ['storage', undefined, true],
    ['expired', '1', true], ['invalid-signature', undefined, false],
  ] as const) {
    const denied = await send(nonce, timestamp, validSignature)
    assert.equal(denied.status, 401, nonce)
    const failure = await denied.json() as { code: string; stage: string; requestId: string }
    assert.equal(failure.code, 'authorization_failed')
    assert.equal(failure.stage, 'authorization')
    assert.equal(failure.requestId, denied.headers.get('x-eden-request-id'))
  }
  assert.equal(submissions, 1)
  assert.deepEqual([...consumed], ['fresh'])
  const logs = (await readFile(loggingFile(loggingOptions), 'utf8')).trim().split('\n')
  assert.deepEqual(logs.filter(line => line.includes('self_awake.request_failed')).map(line => JSON.parse(line).code), [
    'nonce_replayed', 'nonce_capacity_reached', 'nonce_storage_error', 'invalid_timestamp', 'invalid_signature',
  ])
  assert.equal(logs.join('').includes(secret), false)
})
