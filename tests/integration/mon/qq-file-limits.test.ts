import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { QQ_FILE_MAX_BYTES, QQ_FILE_MAX_INPUT_BYTES } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { serviceSignature } from '@eden/integrations'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { AttachmentService } from '../../../src/modules/attachments/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { qqFileTool } from '../../../src/modules/qq-channel/file-tool.ts'
import { QqChannelHttp } from '../../../src/transport/http/qq-channel.ts'

test('a 100 MB file crosses signed HTTP, staging, the durable QQ input and the approved return channel', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eden-qq-100mb-')))
  const database = new EdenDatabase(':memory:', 'mon')
  const repository = new SessionRepository(database, 'mon')
  const identity = { coreBaseUrl: 'https://fixture.invalid', userId: '7', secret: 'test-only' }
  const account = { key: accountKey(identity.coreBaseUrl, '7'), userId: '7', coreBaseUrl: identity.coreBaseUrl }
  const contact = { user_id: '7', bot_qq: '111111', contact_qq: '222222' }
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(database), QQ_FILE_MAX_BYTES)
  const attachments = new AttachmentService(blobs, QQ_FILE_MAX_BYTES)
  const permissions = new PermissionService(database, repository.events)
  const model = await recordedModel([{ text: 'Received the file' }])
  const sessions = new SessionService(repository, model.config, undefined, undefined, undefined, undefined, attachments)
  const session = withAccount(account, () => repository.create('QQ file', [{ assistantId: 1, characterId: 2 }], null,
    { purpose: 'user_chat', sourceChannel: 'qq' }))
  database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
    .run(contact.bot_qq, contact.contact_qq, session.id, 0)
  const mon = { catalog: async () => { throw new Error('must reuse current binding') } } as unknown as MonBindingService
  const bridge = new QqChannelBridge(identity, database, sessions, mon, permissions, blobs, attachments)
  const handler = new QqChannelHttp('mon', bridge)
  const server = createServer((request, response) => { if (!handler.handle(request, response)) response.writeHead(404).end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  t.after(async () => {
    await handler.close(); await sessions.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await model.close(); database.close()
    assert.ok(root.startsWith(await realpath(os.tmpdir()) + path.sep))
    await rm(root, { recursive: true, force: true })
  })
  const post = async (route: string, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID()
    return fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', body, headers: {
      'content-type': 'application/json', 'x-mon-service-id': 'moncore', 'x-mon-service-scope': 'qq:submit',
      'x-mon-service-timestamp': timestamp, 'x-mon-service-nonce': nonce,
      'x-mon-service-signature': serviceSignature(identity.secret, 'moncore', 'qq:submit', timestamp, nonce, route, body),
    } })
  }
  const bytes = Buffer.alloc(QQ_FILE_MAX_BYTES, 0x61), sha256 = createHash('sha256').update(bytes).digest('hex')
  const uploaded = await post('/internal/channels/qq/upload', { ...contact, filename: 'large.bin',
    mime: 'application/octet-stream', content_base64: bytes.toString('base64') })
  assert.equal(uploaded.status, 200)
  const info = await uploaded.json() as { blobId: string; mime: string; byteLength: number; sha256: string }
  assert.equal(info.byteLength, 100_000_000); assert.equal(info.sha256, sha256)
  const ref = { blobId: info.blobId, mime: info.mime, filename: 'large.bin' }
  await bridge.stage({ ...contact, message_id: 'file-1', attachments: [ref] })
  const accepted = await bridge.submit({ ...contact, schema_version: 'qq-turn.v3', message_id: 'text-1',
    text: 'Read the file', assistant_id: 1, character_id: 2 }) as { input_id: string; turn_id: string }
  await sessions.waitForIdle(session.id)
  const input = database.connection.prepare('SELECT state,metadata_json FROM inputs WHERE id=?').get(accepted.input_id)!
  assert.equal(input.state, 'completed')
  assert.equal(JSON.parse(String(input.metadata_json)).attachments[0].byteLength, QQ_FILE_MAX_BYTES)
  assert.ok(!String(input.metadata_json).includes('content_base64'))
  assert.equal(model.requests.length, 1)
  const workspace = new WorkspaceService(database, [], root)
  await writeFile(path.join(root, 'large.bin'), bytes)
  const tool = qqFileTool(repository, blobs, workspace, permissions, session.id, accepted.turn_id)
  const sending = withAccount(account, () => tool.execute({ path: 'large.bin' }, { callId: 'return-file', signal: new AbortController().signal }))
  for (let attempt = 0; attempt < 100 && !permissions.list().some(item => item.state === 'pending'); attempt++)
    await new Promise(resolve => setTimeout(resolve, 5))
  const approval = permissions.list().find(item => item.state === 'pending')!
  assert.ok(approval); permissions.resolve(approval.id, true)
  const queued = await sending
  assert.equal((queued as { byteLength: number }).byteLength, QQ_FILE_MAX_BYTES)
  const event = database.connection.prepare("SELECT payload_json FROM events WHERE kind='qq.file_requested' ORDER BY rowid DESC LIMIT 1").get()!
  const returned = await post('/internal/channels/qq/file', { ...contact, input_id: accepted.input_id, blob_id: JSON.parse(String(event.payload_json)).blobId })
  assert.equal(returned.status, 200)
  const delivered = await returned.json() as { byteLength: number; sha256: string; content_base64: string }
  assert.equal(delivered.byteLength, QQ_FILE_MAX_BYTES)
  assert.equal(createHash('sha256').update(Buffer.from(delivered.content_base64, 'base64')).digest('hex'), sha256)
  const app = withAccount(account, () => repository.create('App input'))
  await assert.rejects(withAccount(account, () => sessions.startWithAttachments(app.id, 'Read', [ref])), /32 MiB/)
  assert.equal((await withAccount(account, () => attachments.read(JSON.parse(String(input.metadata_json)).attachments[0]))).length, QQ_FILE_MAX_BYTES)
  const four = [ref, ref, ref, ref]
  assert.equal((await withAccount(account, () => attachments.snapshot(four, QQ_FILE_MAX_INPUT_BYTES))).length, 4)
  await assert.rejects(withAccount(account, () => attachments.snapshot([...four, ref], QQ_FILE_MAX_INPUT_BYTES)), /input limit/)
})

test('one byte above 100 MB is rejected even when its Base64 length matches the boundary', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eden-qq-oversize-')))
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(database), QQ_FILE_MAX_BYTES)
  const sessions = new SessionService(repository, undefined)
  const bridge = new QqChannelBridge({ coreBaseUrl: 'https://fixture.invalid', userId: '7', secret: 'test-only' },
    database, sessions, {} as MonBindingService, new PermissionService(database, repository.events), blobs,
    new AttachmentService(blobs, QQ_FILE_MAX_BYTES))
  t.after(async () => { await bridge.close(); await sessions.close(); database.close();
    assert.ok(root.startsWith(await realpath(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }) })
  await assert.rejects(bridge.upload({ user_id: '7', bot_qq: '111111', contact_qq: '222222',
    filename: 'large.bin', mime: 'application/octet-stream', content_base64: Buffer.alloc(QQ_FILE_MAX_BYTES + 1).toString('base64') }), /100 MB/)
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM blobs').get()?.n, 0)
})
