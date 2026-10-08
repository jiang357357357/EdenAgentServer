import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import type { AccountRuntimes } from '../../../src/bootstrap/account-runtimes.ts'
import type { ServerConfig } from '../../../src/bootstrap/config.ts'
import { AccountHttp } from '../../../src/transport/http/account-dispatch.ts'

test('account HTTP dispatch keeps the exact internal route allowlist', async () => {
  const routed: string[] = []
  const runtime = {
    qqChannelHttp: { handle: (request: IncomingMessage) => routed.push(`qq:${request.url}`) },
    selfAwakeHttp: { handle: (request: IncomingMessage) => routed.push(`wake:${request.url}`) },
  }
  const accounts = new AccountHttp({ origin: 'local' } as ServerConfig,
    { defaultRuntime: () => runtime } as unknown as AccountRuntimes)
  const response = {} as ServerResponse
  const qqPaths = ['turns', 'status', 'availability', 'permissions', 'permission-mode', 'upload', 'file', 'stage']
    .map(action => `/internal/channels/qq/${action}`)
  for (const url of qqPaths) assert.equal(accounts.handle({ url } as IncomingMessage, response), true)
  for (const action of ['run', 'status']) {
    assert.equal(accounts.handle({ url: `/internal/self-awake/${action}` } as IncomingMessage, response), true)
  }
  for (const url of ['/internal/channels/qq/', '/internal/channels/qq/status/extra', '/internal/channels/qq/status?x=1',
    '/internal/self-awake/unknown', '/internal/self-awake/run/', '/unknown']) {
    assert.equal(accounts.handle({ url } as IncomingMessage, response), false, url)
  }
  await accounts.close()
  assert.deepEqual(routed, [
    ...qqPaths.map(url => `qq:${url}`), 'wake:/internal/self-awake/run', 'wake:/internal/self-awake/status',
  ])
})
