import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { QQ_FILE_MAX_BYTES, toJson } from '@eden/api'
import type { RuntimeTool } from '@eden/runtime-pi'
import { recordedModel } from '@eden/runtime-pi/testing'
import { serviceSignature } from '@eden/integrations'
import { EdenDatabase } from '@eden/store'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { AttachmentRepository, AttachmentService, attachmentTool } from '../../../src/modules/attachments/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { SessionCapabilities } from '../../../src/modules/capabilities/session-capabilities.ts'
import type { SkillRepository } from '../../../src/modules/skills/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { QqChannelHttp } from '../../../src/transport/http/qq-channel.ts'

test('a 100 MB quoted group file reaches signed HTTP, its speaker input and the scoped model attachment tool', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'eden-qq-group-file-')))
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const identity = { coreBaseUrl: 'https://fixture.invalid', userId: '7', secret: 'test-group-file-only' }
  const account = { key: accountKey(identity.coreBaseUrl, '7'), userId: '7', coreBaseUrl: identity.coreBaseUrl }
  const source = { user_id: '7', bot_qq: '100001', group_qq: '300001', contact_qq: '200002' }
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(database), QQ_FILE_MAX_BYTES)
  const attachments = new AttachmentService(blobs, QQ_FILE_MAX_BYTES)
  const permissions = new PermissionService(database, repository.events)
  const readInput = { action: 'read', blobId: '', encoding: 'base64', offset: QQ_FILE_MAX_BYTES - 16, limit: 16 }
  const model = await recordedModel([{ tool: 'read_attachment', input: { action: 'list' } },
    { tool: 'read_attachment', input: readInput }, { text: 'Read the quoted group file' }])
  const blocked: RuntimeTool = { name: 'read_file', revision: 'blocked-test', description: 'owner file', parameters: {},
    execute: async () => { throw new Error('Owner file tool must not be exposed in a group') } }
  const tools = (sessionId: string, turnId: string) => {
    const reader = attachmentTool(new AttachmentRepository(database), attachments, sessionId, turnId)
    const capabilities = new SessionCapabilities(database, repository.events, {} as SkillRepository,
      () => ({ sessionId, owner: 'speaker', profile: 'main', workspaceRoot: '', sourceChannel: 'qq' }), () => [reader, blocked])
    const registry = capabilities.registry()
    assert.deepEqual(registry.tools.map(tool => tool.name), ['read_attachment'])
    return registry.tools
  }
  const sessions = new SessionService(repository, model.config, tools, undefined, undefined, undefined, attachments)
  const session = withAccount(account, () => repository.create('QQ group file', [{ assistantId: 1, characterId: 2 }],
    { channelAudience: 'qq_group' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
  database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)')
    .run(session.id, source.bot_qq, source.group_qq, source.contact_qq, 0, Date.now())
  const mon = { catalog: async () => { throw new Error('must reuse the existing group binding') } } as unknown as MonBindingService
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
  const privateBlob = await withAccount(account, () => blobs.put(Buffer.from('private queue'), 'text/plain'))
  await bridge.stage({ user_id: '7', bot_qq: '100001', contact_qq: '200002', message_id: 'private-file',
    attachments: [{ blobId: privateBlob.id, mime: privateBlob.mime, filename: 'private.txt' }] })
  const bytes = Buffer.alloc(QQ_FILE_MAX_BYTES, 0x61), sha256 = createHash('sha256').update(bytes).digest('hex')
  const uploaded = await post('/internal/channels/qq/upload', { ...source, filename: 'large.bin',
    mime: 'application/octet-stream', content_base64: bytes.toString('base64') })
  assert.equal(uploaded.status, 200)
  const info = await uploaded.json() as { blobId: string; mime: string; byteLength: number; sha256: string }
  assert.equal(info.byteLength, QQ_FILE_MAX_BYTES); assert.equal(info.sha256, sha256)
  readInput.blobId = info.blobId
  const input = { ...source, schema_version: 'qq-group-turn.v2', message_id: 'reply-1', quoted_message_id: 'file-1',
    text: 'Read my quoted file', assistant_id: 1, character_id: 2,
    attachments: [{ blobId: info.blobId, mime: info.mime, filename: 'large.bin' }] }
  const response = await post('/internal/channels/qq/turns', input)
  assert.equal(response.status, 200)
  const accepted = await response.json() as { input_id: string; turn_id: string }
  await sessions.waitForIdle(session.id)
  assert.equal(sessions.faultCount(), 0)
  const row = database.connection.prepare('SELECT state,metadata_json FROM inputs WHERE id=?').get(accepted.input_id)!
  assert.equal(row.state, 'completed')
  const snapshots = JSON.parse(String(row.metadata_json)).attachments
  assert.equal(snapshots[0].byteLength, QQ_FILE_MAX_BYTES)
  assert.ok(!String(row.metadata_json).includes('content_base64'))
  const operations = database.connection.prepare('SELECT state,result_json FROM tool_operations WHERE turn_id=?').all(accepted.turn_id)
  assert.equal(operations.length, 2); assert.ok(operations.every(operation => operation.state === 'completed'))
  const tail = JSON.parse(String(operations[1]!.result_json)) as { content: string }
  assert.equal(Buffer.from(tail.content, 'base64').toString(), 'a'.repeat(16))
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM qq_channel_pending_files').get()?.n, 1)
  assert.throws(() => bridge.status({ ...source, contact_qq: '200003', input_id: accepted.input_id }), /not found/)
  const replay = await bridge.submit(input) as { input_id: string }
  assert.equal(replay.input_id, accepted.input_id)
  await assert.rejects(bridge.submit({ ...input, attachments: [{ blobId: privateBlob.id, mime: privateBlob.mime }] }), /different content or attachments/)
  assert.throws(() => bridge.submit({ ...input, schema_version: 'qq-group-turn.v1' }), /v2 protocol/)
  assert.throws(() => bridge.submit({ ...input, quoted_message_id: undefined }), /quoted file message/)
  assert.throws(() => bridge.submit({ ...input, attachments: Array(5).fill(input.attachments[0]) }), /Too big/)
  const other = withAccount(account, () => repository.create('Other speaker', [{ assistantId: 1, characterId: 2 }],
    { channelAudience: 'qq_group' }, { purpose: 'user_chat', sourceChannel: 'qq' }))
  const inputs = new InputRepository(database, repository.events)
  const foreignSnapshot = await withAccount(account, () => attachments.snapshot([{ blobId: privateBlob.id, mime: privateBlob.mime }]))
  inputs.enqueue(other.id, 'Other document', 'other', { attachments: toJson(foreignSnapshot) })
  const foreign = inputs.claim(other.id)!
  const reader = attachmentTool(new AttachmentRepository(database), attachments, other.id, foreign.turnId)
  await assert.rejects(reader.execute({ action: 'read', blobId: info.blobId },
    { callId: 'foreign', signal: new AbortController().signal }), /当前输入/)
  const old = attachmentTool(new AttachmentRepository(database), attachments, session.id, accepted.turn_id)
  await assert.rejects(old.execute({ action: 'list' }, { callId: 'old', signal: new AbortController().signal }), /active input/)
})
