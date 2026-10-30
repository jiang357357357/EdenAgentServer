import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { desktopFixture } from './fixture.ts'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

test('the actual agent runtime receives compact completed receipts instead of unknown error wrappers', { timeout: 60000 }, async t => {
  const f = await desktopFixture(), requests: any[] = []
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes.toString()
    const value = JSON.parse(body); requests.push(value)
    const last = value.messages.filter((item: any) => item.role === 'tool').at(-1)
    const receipt = last ? JSON.parse(last.content) : undefined
    const position = requests.length - 1
    const calls = [
      () => ({ name: 'desktop_list_windows', arguments: {} }),
      () => ({ name: 'desktop_observe', arguments: { window: receipt.windows[0].window, include_text: true } }),
      () => ({ name: 'desktop_type', arguments: { window: receipt.window, element: receipt.elements.find((item: any) => item.role === 'Edit').element,
        mode: 'replace', text: 'model runtime proof' } }),
      () => ({ name: 'desktop_click', arguments: { window: receipt.window, element: receipt.observation.elements.find((item: any) => item.role === 'Edit').element,
        expect: [{ kind: 'text_equals', locator: { role: 'Edit', label: 'Input' }, text: 'model runtime proof' }] } }),
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ id: `reply-${position}`, object: 'chat.completion.chunk',
      created: 1, model: 'desktop-contract', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    emit({ role: 'assistant' })
    if (position === 3 && !receipt?.observation) t.diagnostic(JSON.stringify({ unexpectedReceipt: receipt }))
    if (calls[position] && (position !== 3 || receipt?.observation)) {
      const call = calls[position]()
      emit({ tool_calls: [{ index: 0, id: `call-${position}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] })
      emit({}, 'tool_calls')
    } else { emit({ content: '已核验测试输入与界面条件。' }); emit({}, 'stop') }
    response.end('data: [DONE]\n\n')
  })
  t.after(async () => {
    try { await server?.close() }
    finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await f.close() }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const observe = f.driver.observe.bind(f.driver), act = f.driver.act.bind(f.driver)
  f.driver.observe = async (...args) => {
    const value = await observe(...args)
    return { ...value, elements: [...value.elements, ...Array.from({ length: 100 }, (_, i) => ({ ...value.elements[0]!,
      token: `history-${i}`, role: 'Text', label: `message-${i} ${'x'.repeat(1000)}`, value: '', actions: [] }))] }
  }
  f.driver.act = async (...args) => { await act(...args); return { status: 'unknown', effect: 'unverifiable', route: 'global_input', message: 'no ack' } }
  const port = (provider.address() as AddressInfo).port
  server = await startServer({ ...loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(f.root, 'runtime'), EDEN_AGENT_PORT: '0',
    EDEN_AGENT_DESKTOP_BROKER_ROOT: f.root }),
    model: { provider: 'desktop-contract', id: 'desktop-contract', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 256000, maxTokens: 1024 } })
  await server.memoryExtractions.close(); server.permissions.setMode('full_access')
  const session = server.sessions.repository.create('Desktop model result contract')
  server.sessions.start(session.id, '在隔离测试窗口中填写并核验输入，不发送任何外部消息。')
  await server.sessions.waitForIdle(session.id)
  assert.equal(server.sessions.faultCount(), 0); assert.equal(requests.length, 5); assert.equal(f.calls.length, 2)
  const receipts = requests.slice(1).map(value => JSON.parse(value.messages.filter((item: any) => item.role === 'tool').at(-1).content))
  assert.equal(receipts[2].execution.state, 'dispatched'); assert.equal(receipts[2].verification.state, 'confirmed')
  assert.equal(receipts[3].verification.scope, 'expected_ui_state'); assert.equal(receipts[3].status, 'verified')
  assert.ok(receipts.slice(2).every(value => !value.outcome && !value.result && value.observationReady === true))
  assert.ok(receipts.every(value => JSON.stringify(value).length < 30000))
  const db = server.sessions.repository.database.connection
  const operations = db.prepare('SELECT tool_name,state FROM tool_operations WHERE session_id=? ORDER BY rowid').all(session.id)
  assert.deepEqual(operations.map(value => value.tool_name), ['desktop_list_windows', 'desktop_observe', 'desktop_type', 'desktop_click'])
  assert.ok(operations.every(value => value.state === 'completed'))
  const audit = db.prepare("SELECT result_json FROM desktop_operations WHERE action='desktop_type'").get()!
  const raw = JSON.parse(String(audit.result_json))
  assert.equal(raw.effect, 'unverifiable'); assert.equal(raw.observation.elements.length, 101)
  assert.ok(JSON.stringify(receipts[2]).length < JSON.stringify(raw).length / 4)
  t.diagnostic(JSON.stringify({ calls: operations.length, modelReceipts: receipts.length, rawCharacters: JSON.stringify(raw).length,
    modelCharacters: JSON.stringify(receipts[2]).length, userDatabaseUsed: false, externalMessagesSent: false }))
})
