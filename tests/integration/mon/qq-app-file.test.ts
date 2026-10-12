import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { MonClient } from '@eden/integrations'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { qqFileTool } from '../../../src/modules/qq-channel/file-tool.ts'
import { ownerQqTarget } from '../../../src/modules/mon/qq-contact.ts'
import { deliverOwnerQqFile } from '../../../src/modules/mon/qq-file-delivery.ts'

async function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'eden-app-qq-file-')))
  const first = path.join(directory, 'first'), second = path.join(directory, 'second')
  for (const root of [first, second]) { mkdirSync(root); writeFileSync(path.join(root, '报告.md'), '老师，这是文件。') }
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  const session = repository.create('App file', [{ assistantId: 1, characterId: 2 }], null, { purpose: 'user_chat', sourceChannel: 'app' })
  const permissions = new PermissionService(database, repository.events)
  const blobs = new BlobService(path.join(directory, 'blobs'), new BlobRepository(database))
  const workspace = new WorkspaceService(database, [], first)
  const controller = new AbortController()
  const requests: Record<string, unknown>[] = []
  let target: string | null = '987654321', outcome = 'sent'
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    assert.equal(request.headers.authorization, 'Token test-token')
    if (request.url === '/api/devices/qq_bot/management/') {
      response.end(JSON.stringify({ success: true, data: { bot_id: target ? 42 : null,
        default_send_target: target ? { target_type: 'user', target_qq_number: target } : null } }))
      return
    }
    assert.equal(request.url, '/api/devices/qq_bot/42/send-file/')
    assert.equal(request.method, 'POST')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    requests.push(body)
    if (outcome === 'rejected') { response.statusCode = 403; response.end(JSON.stringify({ success: false })); return }
    if (outcome === 'unknown') { response.statusCode = 202; response.end(JSON.stringify({ success: false, data: { status: 'unknown' } })); return }
    response.end(JSON.stringify({ success: true, data: { status: 'sent', confirmed: true,
      request_id: body.request_id, target_qq_number: outcome === 'bad-receipt' ? '111112222' : body.target_qq_number,
      filename: body.filename, byte_length: body.byte_length, sha256: body.sha256, file_id: 'file-123' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const client = new MonClient(`http://127.0.0.1:${address.port}`, 'test-token')
  const mon = {
    ownerQqFileTarget: (_id: string, signal: AbortSignal) => ownerQqTarget(client, signal),
    sendOwnerQqFile: (id: string, input: Parameters<typeof deliverOwnerQqFile>[3], signal: AbortSignal) =>
      deliverOwnerQqFile(database, client, id, input, signal),
  }
  const tool = qqFileTool(repository, blobs, workspace, permissions, session.id, session.id, mon)
  const execute = (file = '报告.md', callId = 'file-call') => tool.execute({ path: file }, { callId, signal: controller.signal })
  const pending = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const request = permissions.list().find(item => item.state === 'pending')
      if (request) return request
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Expected file approval')
  }
  const approved = async () => { const result = execute(); permissions.resolve((await pending()).id, true); return result }
  const retry = () => deliverOwnerQqFile(database, client, session.id, { target: { bot: '42', number: '987654321' },
    filename: '报告.md', bytes: Buffer.from('老师，这是文件。'), requestId: `${session.id}:file-call` }, controller.signal)
  return { first, second, database, requests, workspace, permissions, tool, execute, pending, approved, retry,
    target(value: string | null) { target = value }, outcome(value: string) { outcome = value },
    async close() { controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); database.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('App sends workspace bytes to the configured private owner after scoped approval and records a confirmed receipt', async () => {
  const f = await fixture()
  try {
    const running = f.execute()
    const approval = await f.pending()
    assert.equal(approval.resource, 'owner-default-qq-file')
    assert.deepEqual(approval.details, { path: '报告.md', filename: '报告.md', workspaceRoot: f.first, botId: '42', recipientQq: '987654321' })
    assert.equal(f.requests.length, 0)
    f.permissions.resolve(approval.id, true)
    const receipt = await running
    assert.equal((receipt as { status: string }).status, 'sent')
    const visible = f.tool.modelResult!(receipt) as { status: string; confirmed: boolean; filename: string }
    assert.equal(visible.status, 'sent'); assert.equal(visible.confirmed, true); assert.equal(visible.filename, '报告.md')
    assert.doesNotMatch(JSON.stringify(visible), /requestId|request_id|file-123/)
    assert.equal(f.requests.length, 1)
    assert.equal(Buffer.from(String(f.requests[0]!.content_base64), 'base64').toString(), '老师，这是文件。')
    const saved = f.database.connection.prepare('SELECT * FROM mon_contact_deliveries').get()!
    assert.equal(saved.state, 'accepted')
    assert.ok(!String(saved.payload_json).includes('content_base64'))
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='qq.file_requested'").get()?.n, 0)
    assert.deepEqual(await f.retry(), receipt)
    assert.equal(f.requests.length, 1)
  } finally { await f.close() }
})

test('denied file approval never uploads bytes or creates a delivery intent', async () => {
  const f = await fixture()
  try {
    const running = assert.rejects(f.execute(), /Permission denied/)
    f.permissions.resolve((await f.pending()).id, false)
    await running
    assert.equal(f.requests.length, 0)
    assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM mon_contact_deliveries').get()?.n, 0)
  } finally { await f.close() }
})

test('changing the workspace or QQ recipient during approval cannot redirect a file', async () => {
  for (const changed of ['workspace', 'recipient']) {
    const f = await fixture()
    try {
      const failed = assert.rejects(f.execute(), changed === 'workspace' ? /Workspace changed/ : /QQ recipient changed/)
      const approval = await f.pending()
      if (changed === 'workspace') f.workspace.switch(f.second)
      else f.target('111112222')
      f.permissions.resolve(approval.id, true)
      await failed
      assert.equal(f.requests.length, 0)
    } finally { await f.close() }
  }
})

test('unknown or mismatched receipts are never reported sent and are never automatically resent', async () => {
  for (const outcome of ['unknown', 'bad-receipt', 'rejected']) {
    const f = await fixture()
    try {
      f.outcome(outcome)
      await assert.rejects(f.approved(), outcome === 'rejected' ? /Core rejected/ : /not confirmed/)
      assert.equal(f.database.connection.prepare('SELECT state FROM mon_contact_deliveries').get()?.state,
        outcome === 'rejected' ? 'failed' : 'unknown')
      await assert.rejects(f.retry(), error => {
        assert.ok(error instanceof Error && /no automatic resend/.test(error.message))
        if (outcome !== 'rejected') assert.equal((error as Error & { toolOutcome: string }).toolOutcome, 'unknown')
        return true
      })
      assert.equal(f.requests.length, 1)
    } finally { await f.close() }
  }
})

test('unconfigured QQ and paths outside the workspace fail without uploading files', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.execute('../second/报告.md'), /outside the workspace/)
    await assert.rejects(f.execute(path.join(f.first, '报告.md')), /must be relative/)
    f.target(null)
    await assert.rejects(f.execute(), /尚未配置 QQ 机器人/)
    assert.equal(f.permissions.list().length, 0)
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('files larger than 8 MiB fail before any Core upload', async () => {
  const f = await fixture()
  try {
    writeFileSync(path.join(f.first, '报告.md'), Buffer.alloc(8 * 1024 * 1024 + 1))
    await assert.rejects(f.approved(), /at most 8 MiB/)
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('an interrupted upload leaves a durable unknown intent and a replay cannot send it again', async () => {
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  const session = repository.create('Interrupted upload', [], null, { purpose: 'user_chat', sourceChannel: 'app' })
  const controller = new AbortController()
  let uploads = 0
  const client = {
    async get() { return { data: { bot_id: 42, default_send_target: { target_type: 'user', target_qq_number: '987654321' } } } },
    async post(_path: string, _body: unknown, signal: AbortSignal, timeout: number) {
      uploads++
      assert.equal(timeout, 180000)
      controller.abort()
      signal.throwIfAborted()
    },
  } as unknown as MonClient
  const input = { target: { bot: '42', number: '987654321' }, filename: 'note.txt', bytes: Buffer.from('hello'), requestId: 'interrupted-call' }
  try {
    await assert.rejects(deliverOwnerQqFile(database, client, session.id, input, controller.signal), /not confirmed/)
    assert.equal(database.connection.prepare('SELECT state FROM mon_contact_deliveries').get()?.state, 'unknown')
    await assert.rejects(deliverOwnerQqFile(database, client, session.id, input, new AbortController().signal), /no automatic resend/)
    assert.equal(uploads, 1)
  } finally { database.close() }
})
