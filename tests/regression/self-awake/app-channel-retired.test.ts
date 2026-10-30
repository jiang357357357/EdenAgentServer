import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { createServer } from 'node:http'
import { MonClient } from '@eden/integrations'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { openRuntime } from '../../../src/bootstrap/runtime-scope.ts'
import { MonBindingService } from '../../../src/modules/mon/index.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { projectRecordedResult, toolModelResult } from '../../../src/modules/tool-results/model-result-catalog.ts'

for (const origin of ['mon', 'local'] as const) test(`${origin}: full host catalog retires App delivery while retaining configured contact tools`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-retired-app-'))
  const account = origin === 'mon'
    ? { key: accountKey('http://127.0.0.1:1', 'synthetic'), userId: 'synthetic', coreBaseUrl: 'http://127.0.0.1:1' } : undefined
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => { try { await runtime?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const config = loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }, root)
  runtime = await openRuntime({ ...config, origin, ...(account ? { account } : {}) })
  withAccount(account, () => {
    const names = runtime!.services.sessions.toolCatalog().map(tool => tool.name)
    assert.ok(!names.includes('send_app_message'))
    assert.ok(!names.includes('eden_send_app_message'))
    for (const name of ['list_contact_channels', 'send_qq_message', 'send_external_email', 'control_esp32_device'])
      assert.equal(names.includes(name), origin === 'mon', name)
    assert.ok(names.includes('write_diary'))
    assert.ok(names.includes('set_self_awake_timer'))
  })
})

test('isolated production runtime rejects retired tool calls and loading, preserves App history and continues diary and ordinary replies', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-retired-app-runtime-'))
  const rejectedText = 'RETIRED_APP_MESSAGE_MUST_NOT_BE_DELIVERED'
  const diaryText = '日记中记下晚霞和自己的心情。'
  const model = await recordedModel([
    { text: '我们可以慢慢聊晚霞。' },
    { tool: 'send_app_message', input: { message: rejectedText } },
    { tool: 'eden_send_app_message', input: { message: rejectedText } },
    { tool: 'load_tools', input: { tools: [{ id: 'builtin:send_app_message' }] } },
    { tool: 'write_diary', input: { title: '晚霞', content: diaryText } },
    { tool: 'set_self_awake_timer', input: { afterMinutes: 120, reason: '休息后醒来' } },
    { text: '日记已保存。' },
    { text: '我也喜欢金色的晚霞。' },
  ])
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined
  t.after(async () => {
    try { await runtime?.close() } finally { await model.close(); await rm(root, { recursive: true, force: true }) }
  })
  runtime = await openRuntime({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }, root), model: model.config })
  const { sessions, selfAwake, permissions, jobs } = runtime.services
  permissions.setMode('full_access')
  const actor = { assistantId: 4, characterId: 4, profile: { character: { name: '普拉娜', system_prompt: '你是普拉娜。' } } }
  const chat = sessions.repository.create('晚霞', [actor])
  const background = sessions.repository.create('角色后台', [actor], { sessionPurpose: 'self_awake' }, { purpose: 'self_awake', sourceChannel: 'internal' })
  sessions.start(chat.id, '今天的晚霞很好看。')
  await sessions.waitForIdle(chat.id)
  const before = JSON.stringify(sessions.repository.checkpoint(chat.id))
  selfAwake.start()
  const job = jobs.schedule({ kind: 'self_awake', sessionId: background.id, dueAt: Date.now() - 1,
    key: randomUUID(), causationId: '', depth: 0, payload: {} })
  assert.equal(jobs.claim()!.id, job.id)
  selfAwake.dispatch(jobs.read(job.id))
  await sessions.waitForIdle(background.id)
  await setImmediate()
  jobs.settleInputs()
  const run = selfAwake.repository.list({}).results.find(value => value.jobId === job.id)!
  assert.equal(run.status, 'completed')
  assert.equal(selfAwake.repository.read(run.id).diaries[0]!.content, diaryText)
  assert.equal(JSON.stringify(sessions.repository.checkpoint(chat.id)), before)
  assert.equal(runtime.database.connection.prepare('SELECT COUNT(*) n FROM app_contact_deliveries').get()!.n, 0)
  const messages = model.requests[6]!.messages as { role: string; tool_call_id?: string; content: unknown;
    tool_calls?: { id: string; function: { name: string } }[] }[]
  const callNames = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(call => [call.id, call.function.name] as const)))
  const toolReply = (name: string) => messages.filter(message => message.role === 'tool' && callNames.get(message.tool_call_id ?? '') === name)
  for (const name of ['send_app_message', 'eden_send_app_message']) {
    assert.ok(toolReply(name).length > 0, `${name} error must return to the model`)
    assert.match(JSON.stringify(toolReply(name)), /not found|not registered|unknown|不存在|未注册/i)
  }
  assert.match(JSON.stringify(toolReply('load_tools')), /failed/)
  const turnId = runtime.database.connection.prepare('SELECT turn_id FROM self_awake_runs WHERE id=?').get(run.id)!.turn_id
  assert.ok(typeof turnId === 'string')
  const operations = runtime.database.connection.prepare('SELECT tool_name,state FROM tool_operations WHERE turn_id=? ORDER BY rowid').all(turnId)
  assert.deepEqual(operations.map(row => row.tool_name), ['load_tools', 'write_diary', 'set_self_awake_timer'])
  assert.ok(operations.every(row => row.state === 'completed'))
  const opening = model.requests[1]!
  const schemas = (opening.tools as { function: { name: string } }[]).map(tool => tool.function.name)
  assert.ok(!schemas.some(name => name.includes('send_app_message')))
  assert.match(JSON.stringify(opening.messages), /今天的晚霞很好看/)
  sessions.start(chat.id, '我喜欢金色。')
  await sessions.waitForIdle(chat.id)
  assert.equal(model.requests.length, 8)
  const reply = JSON.stringify(model.requests[7]!.messages)
  assert.match(reply, /今天的晚霞很好看/)
  assert.match(reply, /我们可以慢慢聊晚霞/)
  assert.doesNotMatch(reply, new RegExp(`${rejectedText}|${diaryText}`))
})

test('real channel discovery over HTTP advertises QQ, email, desktop and device without App', async t => {
  const http = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/devices/qq_bot/management/') response.end(JSON.stringify({ data: {
      bot_id: 42, access: { botcore_connected: true }, default_send_target: { target_type: 'user', target_qq_number: '123456' },
    } }))
    else if (request.url === '/api/devices/qq_bot/?summary=true') response.end(JSON.stringify({ data: [{ id: '42', status: 'online' }] }))
    else if (request.url === '/api/agent/external-email/status/') response.end(JSON.stringify({ ready: true, default_to: 'synthetic@example.invalid' }))
    else { response.statusCode = 404; response.end('{}') }
  })
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const client = new MonClient(`http://127.0.0.1:${(http.address() as { port: number }).port}`, 'synthetic-token')
  const result = await Reflect.apply(MonBindingService.prototype.contactChannels, { assistantClient: () => client }, ['synthetic', new AbortController().signal])
  assert.deepEqual(Object.keys(result as object).sort(), ['desktop', 'device', 'email', 'qq'])
  assert.equal((result as { qq: { available: boolean } }).qq.available, true)
  assert.equal((result as { email: { available: boolean } }).email.available, true)
})

test('retired tool has no active result contract but historical receipts remain readable', () => {
  assert.equal(toolModelResult('send_app_message'), undefined)
  for (const name of ['send_app_message', 'eden_send_app_message']) {
    const receipt = { status: 'saved', message: '以前已收到的问候' }
    assert.deepEqual(projectRecordedResult(name, receipt, {}, undefined, 'builtin'), receipt)
  }
})
