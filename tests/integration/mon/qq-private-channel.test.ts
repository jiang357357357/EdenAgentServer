import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { toJson } from '@eden/api'
import type { AttachmentRef } from '@eden/api'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { AttachmentService } from '../../../src/modules/attachments/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import { WorkspaceService } from '../../../src/modules/workspace/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { qqFileTool } from '../../../src/modules/qq-channel/file-tool.ts'

const identity = { coreBaseUrl: 'https://core.example', userId: '7', secret: 'test-only' }
const contact = { user_id: '7', bot_qq: '111111', contact_qq: '222222' }
const account = { key: accountKey(identity.coreBaseUrl, '7'), userId: '7', coreBaseUrl: identity.coreBaseUrl }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-qq-private-'))
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(database), 10 * 1024 * 1024)
  const attachments = new AttachmentService(blobs), permissions = new PermissionService(database, repository.events)
  const sessions = new SessionService(repository, undefined)
  const session = withAccount(account, () => repository.create('QQ', [{ assistantId: 1, characterId: 2 }], null,
    { purpose: 'user_chat', sourceChannel: 'qq' }))
  database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
    .run(contact.bot_qq, contact.contact_qq, session.id, 0)
  const mon = { catalog: async () => { throw new Error('must reuse current binding') } } as unknown as MonBindingService
  const bridge = new QqChannelBridge(identity, database, sessions, mon, permissions, blobs, attachments)
  const inputs = new InputRepository(database, repository.events)
  return { root, database, repository, blobs, attachments, permissions, sessions, session, bridge, inputs,
    close: async () => { await bridge.close(); await sessions.close(); database.close(); await rm(root, { recursive: true, force: true }) } }
}

test('private bridge keeps staging transactional, deduplicates input and refuses character change while queued', async t => {
  const f = await fixture(); t.after(f.close)
  const file = await f.bridge.upload({ ...contact, filename: 'example.txt', mime: 'text/plain',
    content_base64: Buffer.from('attachment').toString('base64') }) as AttachmentRef
  const ref = { blobId: file.blobId, mime: file.mime, filename: 'example.txt' }
  await f.bridge.stage({ ...contact, message_id: 'file-1', attachments: [ref] })
  const stageInput: SessionService['startWithAttachments'] = async (id, text, refs, key, _environment, onCommit) => {
    const snapshots = await f.attachments.snapshot(refs)
    return f.inputs.enqueue(id, text, key!, toJson({ attachments: snapshots }), 'prompt', undefined, onCommit)
  }
  t.mock.method(f.sessions, 'startWithAttachments', stageInput)
  const input = { ...contact, schema_version: 'qq-turn.v3', message_id: 'text-1', text: '查看附件', assistant_id: 1, character_id: 2 }
  const first = await f.bridge.submit(input) as { input_id: string; session_id: string }
  assert.equal(first.session_id, f.session.id)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM qq_channel_pending_files').get()?.n, 0)
  assert.equal((await f.bridge.submit(input) as { input_id: string }).input_id, first.input_id)
  await assert.rejects(f.bridge.submit({ ...input, text: '另一个问题' }), /different content/)
  await assert.rejects(f.bridge.submit({ ...input, message_id: 'text-2', character_id: 3 }), /current QQ turn/)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS n FROM inputs').get()?.n, 1)
})

test('private status preserves final text, tool/approval/file updates and restricts file retrieval to its contact', async t => {
  const f = await fixture(); t.after(f.close)
  const accepted = f.inputs.enqueue(f.session.id, '执行', 'status')
  f.database.connection.prepare("UPDATE inputs SET state='running' WHERE id=?").run(accepted.inputId)
  const context = { sessionId: f.session.id, turnId: accepted.turnId, callId: 'approve', signal: new AbortController().signal }
  const pending = f.permissions.request(context, 'contact.qq', 'current-qq-conversation', { path: 'result.txt' })
  await new Promise<void>(resolve => setImmediate(resolve))
  const approval = f.permissions.list()[0]!
  const info = await withAccount(account, () => f.blobs.put(Buffer.from('result'), 'text/plain'))
  for (const [kind, payload] of [
    ['operation.started', { name: 'send_qq_file' }],
    ['operation.completed', { callId: 'tool', outcome: 'completed', result: { path: 'result.txt', bytes: 6 } }],
    ['qq.file_requested', { blobId: info.id, filename: 'result.txt', byteLength: 6 }],
    ['agent.message_end', { message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } }],
  ] as const) f.repository.events.append(f.session.id, accepted.turnId, kind, toJson(payload))
  f.database.connection.prepare("UPDATE inputs SET state='completed' WHERE id=?").run(accepted.inputId)
  const status = f.bridge.status({ ...contact, input_id: accepted.inputId }) as { text: string; updates: { kind: string; preview?: string }[] }
  assert.equal(status.text, '完成')
  assert.deepEqual(status.updates.map(item => item.kind), ['approval', 'tool_start', 'tool_end', 'file_send'])
  assert.match(status.updates[0]!.preview!, /result.txt/)
  f.permissions.resolve(approval.id, true); await pending
  const resolved = f.bridge.status({ ...contact, input_id: accepted.inputId }) as { updates: { kind: string }[] }
  assert.ok(!resolved.updates.some(item => item.kind === 'approval'))
  assert.ok(resolved.updates.some(item => item.kind === 'approval_resolved'))
  const file = await f.bridge.file({ ...contact, input_id: accepted.inputId, blob_id: info.id }) as { content_base64: string }
  assert.equal(Buffer.from(file.content_base64, 'base64').toString(), 'result')
  await assert.rejects(f.bridge.file({ ...contact, contact_qq: '999999', input_id: accepted.inputId, blob_id: info.id }), /not found/)
})

test('QQ workspace file is read only after approval and rejected paths never create delivery events', async t => {
  const f = await fixture(); t.after(f.close)
  const workspace = new WorkspaceService(f.database, [])
  workspace.switch(f.root)
  await writeFile(path.join(f.root, 'result.txt'), 'approved bytes')
  const turnId = randomUUID(), tool = qqFileTool(f.repository, f.blobs, workspace, f.permissions, f.session.id, turnId)
  const context = { callId: 'file', signal: new AbortController().signal }
  const denied = tool.execute({ path: 'result.txt' }, context)
  const rejection = assert.rejects(denied, /Permission denied/)
  for (let attempt = 0; !f.permissions.list().length && attempt < 100; attempt++)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(f.permissions.list().length, 1)
  f.permissions.resolve(f.permissions.list()[0]!.id, false); await rejection
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='qq.file_requested'").get()?.n, 0)
  f.permissions.setQqMode(contact.bot_qq, contact.contact_qq, 'full_access')
  await tool.execute({ path: 'result.txt' }, context)
  await assert.rejects(tool.execute({ path: '../escape.txt' }, context), /outside/)
  await assert.rejects(tool.execute({ path: 'result.txt', filename: '../unsafe' }, context), /filename/)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='qq.file_requested'").get()?.n, 1)
})
