import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { SharedRemoteError, SharedWorkspaceRemote } from '../../../src/modules/shared-workspace/remote.ts'

const credential = { accountKey: 'fixture', coreBaseUrl: 'http://127.0.0.1:12345', token: 'fixture-only' }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function remote(fetcher: typeof fetch, controller = new AbortController()) {
  return new SharedWorkspaceRemote(async () => credential, () => controller.signal, fetcher)
}

test('JSON requests stay under configured Core base and reject redirects', async () => {
  let count = 0
  const client = remote(async (url, init) => {
    count++; assert.equal(String(url), 'http://127.0.0.1:12345/api/shared-workspace/v1/spaces')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Token fixture-only')
    return Response.json({ spaces: [] })
  })
  assert.deepEqual(await client.request('GET', 'spaces'), { spaces: [] })
  await assert.rejects(client.request('GET', '../users'))
  await assert.rejects(client.request('GET', 'https://other.invalid/'))
  await assert.rejects(client.request('GET', 'spaces/%2e%2e/private'))
  assert.equal(count, 1)
})

test('CAS conflict preserves structured current version and status for sync engine', async () => {
  const current = { fileId: 'fixture-file', revision: 8 }
  const client = remote(async () => Response.json({ error: 'conflict', current }, { status: 409 }))
  await assert.rejects(client.request('POST', 'spaces/id/commit', {}), error => {
    assert.ok(error instanceof SharedRemoteError)
    assert.equal(error.status, 409)
    assert.deepEqual(error.body.current, current)
    return true
  })
})

test('blob uploads and downloads enforce digest and 16 MiB limit', async () => {
  const bytes = Buffer.from('完整文件')
  const client = remote(async () => new Response(bytes))
  assert.deepEqual(Buffer.from(await client.download('space', hash(bytes))), bytes)
  await client.upload('space', hash(bytes), bytes)
  await assert.rejects(client.upload('space', '0'.repeat(64), bytes), /校验和/)
  await assert.rejects(client.download('space', '0'.repeat(64)), /校验失败/)
  const oversized = remote(async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)))
  await assert.rejects(oversized.download('space', hash(bytes)), /大小限制/)
})

test('detached credentials abort before sending and distinguish authorization errors', async () => {
  const controller = new AbortController()
  controller.abort(new Error('logged out'))
  let calls = 0
  await assert.rejects(remote(async () => { calls++; return Response.json({}) }, controller).request('GET', 'spaces'), /logged out/)
  assert.equal(calls, 0)
  await assert.rejects(remote(async () => Response.json({ error: 'disabled' }, { status: 403 })).request('GET', 'spaces'), /403/)
  await assert.rejects(remote(async () => Response.json({ error: 'invalid' }, { status: 401 })).request('GET', 'spaces'), /401/)
})

test('device registration precedes transfer, is reused, and revoked identity is never regenerated', async () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const endpoints: string[] = []
  let revoked = false
  const client = new SharedWorkspaceRemote(async () => credential, () => new AbortController().signal, async (url, init) => {
    const endpoint = new URL(String(url)).pathname.split('/').at(-1)!
    endpoints.push(endpoint)
    assert.equal(new Headers(init?.headers).get('X-Shared-Workspace-Device'), id)
    return revoked ? Response.json({ error: 'device_revoked' }, { status: 403 }) : Response.json({})
  }, async () => id)
  await Promise.all([client.request('GET', 'spaces'), client.request('GET', 'spaces')])
  assert.deepEqual(endpoints, ['devices', 'spaces', 'spaces'])
  revoked = true
  client.resetRegistration()
  await assert.rejects(client.request('GET', 'spaces'), /403/)
  assert.deepEqual(endpoints, ['devices', 'spaces', 'spaces', 'devices'])
})

test('bounded DRF detail errors retain actionable migration and permission reasons', async () => {
  await assert.rejects(remote(async () => Response.json({ detail: '请先完成 SharedWorkspace 数据库迁移' }, { status: 503 }))
    .request('GET', 'spaces'), /请先完成 SharedWorkspace 数据库迁移/)
  await assert.rejects(remote(async () => Response.json({ detail: '该账号不是此资料库成员' }, { status: 403 }))
    .request('GET', 'spaces'), /该账号不是此资料库成员/)
  await assert.rejects(remote(async () => Response.json({ detail: { private: 'must not stringify' } }, { status: 400 }))
    .request('GET', 'spaces'), error => {
      assert.ok(error instanceof SharedRemoteError)
      assert.equal(error.body.error, 'request_failed')
      return true
    })
})
