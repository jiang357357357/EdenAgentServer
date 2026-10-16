import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { protocolVersion, tokenProtocolPrefix, type SessionEvent, type SessionSummary } from '@eden/api'
import { TuiApp } from '../../../tui/app.ts'
import type { AuthFlow } from '../../../tui/auth-flow.ts'
import type { Terminal } from '../../../tui/terminal.ts'
import type { TuiRpcClient } from '../../../tui/rpc-client.ts'
import type { ReconnectLoop } from '../../../tui/reconnect-loop.ts'
import type { ScreenEntry } from '../../../tui/screen-state.ts'

interface AppAccess {
  auth: AuthFlow; terminal: Terminal; rpc: TuiRpcClient; reconnect: ReconnectLoop
  models: { refresh(): Promise<void>; ensure(): Promise<boolean> }
  connected: boolean; current?: SessionSummary; queue: Promise<void>
  onEvent(event: SessionEvent): void
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('fixture condition timed out')
    await setTimeout(10)
  }
}

test('a real WebSocket disconnect restores the session, draft and clock without resending a turn', { timeout: 10_000 }, async context => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const sessionId = randomUUID(), turnId = randomUUID()
  const fixture = await mkdtemp(path.join(tmpdir(), 'eden-tui-reconnect-'))
  const tokenFile = path.join(fixture, 'capability.token')
  await writeFile(tokenFile, 'a'.repeat(32))
  const session: SessionSummary = { id: sessionId, title: '恢复测试', archived: false, titleSource: 'user', status: 'active', executionStatus: 'idle',
    runtimeOrigin: 'local', purpose: 'user_chat', sourceChannel: 'app', participants: [], environment: null, createdAt: 1000, updatedAt: 5000 }
  const events: SessionEvent[] = []
  const makeEvent = (seq: number, eventType: string, payload: SessionEvent['payload']): SessionEvent =>
    ({ id: randomUUID(), sessionId, turnId, seq: String(seq), eventType, payload, createdAt: seq * 1000 })
  let connections = 0, submissions = 0, injected = false
  const tokenKeys = ['EDEN_AGENT_LOCAL_CAPABILITY_TOKEN', 'EDEN_AGENT_MON_CAPABILITY_TOKEN', 'EDEN_AGENT_CAPABILITY_TOKEN']
  const environment = tokenKeys.map(key => [key, process.env[key]] as const)
  for (const key of tokenKeys) delete process.env[key]
  const tokens: string[] = []
  server.on('connection', (socket, handshake) => {
    connections++
    tokens.push(String(handshake.headers['sec-websocket-protocol']))
    socket.on('message', async raw => {
      const request = JSON.parse(raw.toString()) as { id: number; method: string; params: Record<string, unknown> }
      const send = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      if (request.method === 'turn.start') {
        submissions++
        events.push(makeEvent(1, 'turn.started', {}), makeEvent(2, 'operation.started', { callId: 'call', name: 'read_file', args: { path: 'fixture' } }),
          makeEvent(3, 'operation.completed', { callId: 'call', result: '读取成功' }),
          makeEvent(4, 'agent.message_end', { messageId: 'history-reply', message: { role: 'assistant', content: '断线期间的回答' } }),
          makeEvent(5, 'turn.completed', {}))
        await writeFile(tokenFile, 'b'.repeat(32)) // Simulate Server token rotation before reconnect.
        socket.terminate() // The request was received, but its acknowledgement never arrived.
        return
      }
      const responses: Record<string, unknown> = {
        initialize: { protocolVersion, serverName: 'fixture', serverVersion: '1', agentCoreVersion: '1', runtimeOrigin: 'local', capabilities: ['session-events'] },
        'session.list': [session], 'session.read': session,
        'message.list': { items: events.filter(event => event.eventType === 'agent.message_end'), hasMore: false, nextCursor: null },
        'event.list': { items: events.filter(event => BigInt(event.seq) > BigInt(String(request.params.afterSeq ?? '0'))), hasMore: false, nextCursor: null },
        'session.timing.read': { turn: events.length ? { turnId, startedAt: 1000, finishedAt: 5000, outcome: 'completed' } : null,
          seq: events.length ? '5' : '0', observedAt: 5000 },
        'operation.list': events.length ? [{ operationId: 'op', sessionId, turnId, toolCallId: 'call', toolName: 'read_file',
          capability: 'read', resource: 'fixture', state: 'completed', request: { path: 'fixture' }, result: '读取成功', error: null,
          createdAt: 2000, updatedAt: 3000 }] : [], 'permission.list': [], 'question.list': [],
        'workspace.info': { name: 'fixture', path: 'E:/fixture', status: 'ready', kind: 'external', defaultPath: null, error: null },
      }
      if (request.method in responses) send(responses[request.method])
      else socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: request.method } }))
    })
  })
  const instance = new TuiApp({ origin: 'local', port: address.port, tokenFile, coreUrl: 'http://127.0.0.1:1', authFile: '', sessionId }, 'a'.repeat(32))
  const app = instance as unknown as AppAccess
  app.models = { ensure: async () => true, refresh: async () => {
    if (connections > 1 && !injected) {
      injected = true
      app.onEvent(makeEvent(6, 'agent.message_end', { messageId: 'reply', message: { role: 'assistant', content: '恢复后的回答' } }))
    }
  } }
  const view = app.terminal as unknown as { input: string; entries: ScreenEntry[]; keypress(text?: string, key?: { name: string }): void }
  context.after(async () => {
    app.reconnect.stop(); app.auth.cancel(); app.terminal.close(); app.rpc.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(fixture, { recursive: true, force: true })
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  await app.auth.bootstrap()
  assert.equal(app.connected, true)
  view.keypress('待确认的消息'); view.keypress(undefined, { name: 'return' })
  await app.queue
  assert.equal(view.input, '')
  await until(() => connections === 2 && app.auth.authenticated && injected)
  assert.equal(app.current?.id, sessionId)
  assert.equal(submissions, 1)
  assert.ok(tokens[0]?.includes(`${tokenProtocolPrefix}${'a'.repeat(32)}`))
  assert.ok(tokens[1]?.includes(`${tokenProtocolPrefix}${'b'.repeat(32)}`))
  assert.equal(app.terminal.turnElapsedMs, 4000)
  assert.ok(view.entries.some(entry => entry.text.includes('读取成功')))
  assert.ok(view.entries.some(entry => entry.text.includes('恢复后的回答')))
  assert.equal(view.entries.filter(entry => entry.key === 'message:reply').length, 1)
  app.terminal.restoreDraft()
  assert.equal(view.input, '待确认的消息')
  assert.equal(submissions, 1)
})
