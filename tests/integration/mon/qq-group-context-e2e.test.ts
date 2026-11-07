import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import type { MonBindingService } from '../../../src/modules/mon/index.ts'
import type { BlobService } from '../../../src/modules/blobs/index.ts'
import type { AttachmentService } from '../../../src/modules/attachments/index.ts'
import { QqChannelBridge } from '../../../src/modules/qq-channel/bridge.ts'
import { QqChannelHttp } from '../../../src/transport/http/qq-channel.ts'
import { QqSharedRepository } from '../../../src/modules/qq-channel/shared-repository.ts'
import { mockSharedCatalog } from './qq-shared-catalog.ts'

const core = path.resolve('../Core')
const python = path.join(core, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const script = path.join(core, 'Application/Domain/BOT/tests/run_group_context_fixture.py')

test('Core group store and reply projection reach the actual Agent through signed HTTP', {
  timeout: 90_000, skip: existsSync(python) && existsSync(script) ? false : 'Sibling Core fixture unavailable',
}, async t => {
  const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
  const model = await recordedModel([{ text: 'E2E_MODEL_B_PUBLIC_ANSWER' }, { text: 'E2E_MODEL_A_PUBLIC_ANSWER' }])
  const config = { ...model.config, contextWindow: 256000 }
  const identity = { coreBaseUrl: 'https://fixture.invalid', userId: '1', secret: 'group-context-cross-process-secret' }
  mockSharedCatalog(t, config, '1')
  const account = { key: accountKey(identity.coreBaseUrl, '1'), userId: '1', coreBaseUrl: identity.coreBaseUrl }
  const sessions = new SessionService(repository, config)
  {
    const session = withAccount(account, () => repository.create('Group', [{ assistantId: 1, characterId: 2 }],
      { sourceChannel: 'qq', channelAudience: 'qq_group', botQq: '100001', groupQq: '300001' },
      { purpose: 'user_chat', sourceChannel: 'qq' }))
    new QqSharedRepository(database).bind(session.id, '100001', '300001')
  }
  const mon = { catalog: async () => { throw new Error('Must reuse bound shared room') } } as unknown as MonBindingService
  const bridge = new QqChannelBridge(identity, database, sessions, mon, new PermissionService(database, repository.events),
    {} as BlobService, {} as AttachmentService)
  const inputs: unknown[] = [], submit = bridge.submit.bind(bridge)
  const pages: unknown[] = [], ingest = bridge.ingestGroupHistory.bind(bridge)
  t.mock.method(bridge, 'ingestGroupHistory', (raw: unknown) => { pages.push(raw); return ingest(raw) })
  t.mock.method(bridge, 'submit', (raw: unknown) => { inputs.push(raw); return submit(raw) })
  const handler = new QqChannelHttp('mon', bridge)
  const server = createServer((request, response) => { if (!handler.handle(request, response)) response.writeHead(404).end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const child = spawn(python, ['-B', script, String(port)],
  { cwd: core, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => {
    if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    await handler.close(); await sessions.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await model.close(); database.close()
  })
  const result = await new Promise<{ owner_id: string; public_replies: string[]; stored_trigger_count: number;
    napcat: { group_id: string }[]; outgoing: { command: string; data: { target_type: string; target_qq_number: string; content: string } }[] }>((resolve, reject) => {
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000) })
    child.once('error', reject)
    child.once('close', code => {
      const line = stdout.split('\n').find(value => value.startsWith('EDEN_GROUP_CONTEXT_RESULT '))
      if (code !== 0 || !line) reject(new Error(`Core fixture exited ${code}: ${stderr}`))
      else resolve(JSON.parse(line.slice('EDEN_GROUP_CONTEXT_RESULT '.length)))
    })
  })
  assert.equal(result.owner_id, identity.userId)
  assert.equal(result.stored_trigger_count, 3)
  assert.deepEqual(result.public_replies, ['E2E_MODEL_B_PUBLIC_ANSWER', 'E2E_MODEL_A_PUBLIC_ANSWER'])
  assert.ok(result.outgoing.every(value => value.command === 'reply' && value.data.target_type === 'group'
    && value.data.target_qq_number === '300001'))
  assert.equal(model.requests.length, 2)
  assert.match(JSON.stringify(model.requests[0]), /E2E_GROUP_BUDGET_500/)
  assert.match(JSON.stringify(model.requests[0]), /B（超级管理员）（200002）/)
  assert.match(JSON.stringify(model.requests[0]), /A（管理员）（200001）/)
  assert.match(JSON.stringify(model.requests[1]), /E2E_MODEL_B_PUBLIC_ANSWER/)
  assert.doesNotMatch(JSON.stringify(model.requests), /E2E_PRIVATE_SECRET|E2E_OTHER_GROUP_SECRET/)
  assert.ok(pages.some(page => Buffer.byteLength(JSON.stringify(page)) > 65_536))
  assert.ok(Buffer.byteLength(JSON.stringify(inputs[0])) < 65_536)
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM qq_group_sessions').get()?.n, 1)
  assert.equal(result.napcat.length, 2)
  assert.ok(result.napcat.every(value => value.group_id === '300001'))
  const first = model.requests[0] as { messages: unknown[] }, second = model.requests[1] as { messages: unknown[] }
  const mismatch = first.messages.findIndex((value, index) => JSON.stringify(second.messages[index]) !== JSON.stringify(value))
  assert.equal(mismatch, -1, JSON.stringify({ mismatch,
    before: (JSON.stringify(first.messages[mismatch]) ?? '').slice(0, 600), after: (JSON.stringify(second.messages[mismatch]) ?? '').slice(0, 600) }))
  assert.ok(Number(database.connection.prepare('SELECT COUNT(*) AS n FROM service_nonces').get()?.n) >= 4)
})
