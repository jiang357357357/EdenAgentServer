import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { websocketProtocol, tokenProtocolPrefix } from '@eden/api'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

function request<T = Record<string, unknown>>(socket: WebSocket, method: string, params: unknown = {}): Promise<T> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', receive)
      reject(new Error(`RPC timed out: ${method}`))
    }, 5000)
    const receive = (data: Buffer) => {
      const reply = JSON.parse(data.toString()) as { id: string; result: T; error?: { message: string } }
      if (reply.id !== id) return
      clearTimeout(timeout)
      socket.off('message', receive)
      if (reply.error) reject(new Error(reply.error.message))
      else resolve(reply.result)
    }
    socket.on('message', receive)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

async function connect(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, [websocketProtocol, tokenProtocolPrefix + token])
  await once(socket, 'open')
  await request(socket, 'initialize', {
    protocolVersion: 2, runtimeOrigin: 'local', clientName: 'workspace-recovery', clientVersion: '1', capabilities: [],
  })
  return socket
}

async function approve(socket: WebSocket, sessionId: string, capability: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const requests = await request<{ id: string; state: string; capability: string }[]>(socket, 'permission.list', { sessionId })
    const pending = requests.find(item => item.state === 'pending' && item.capability === capability)
    if (pending) return request(socket, 'permission.resolve', { requestId: pending.id, decision: 'once' })
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Approval did not arrive: ${capability}`)
}

test('missing persisted workspace still chats, rejects commands, and recovers real approved writes across restart', { timeout: 60000 }, async t => {
  const started = Date.now()
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-workspace-runtime-'))
  const data = path.join(root, 'storage'), missing = path.join(root, 'old-install', 'project')
  const recovered = path.join(root, 'reselected-project')
  await mkdir(recovered)
  const database = new EdenDatabase(path.join(data, 'eden-agent.db'), 'local')
  database.connection.prepare('INSERT INTO runtime_settings VALUES(?,?,?)').run('workspace.root', JSON.stringify(missing), Date.now())
  const { id: sessionId } = new SessionRepository(database, 'local').create('Workspace recovery')
  database.connection.prepare('INSERT INTO session_workspaces(session_id,settings_json,updated_at) VALUES(?,?,?)')
    .run(sessionId, JSON.stringify({ 'workspace.root': missing }), Date.now())
  database.close()
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'command-output.txt' -Value 'command-recovered' -NoNewline"
    : "printf command-recovered > command-output.txt"
  const model = await recordedModel([
    { text: '工作区丢失时仍可聊天' },
    { tool: 'load_tools', input: { tools: [{ id: 'exec_command' }] } },
    { tool: 'exec_command', input: { command: 'echo must-not-run' } },
    { text: '工作区不可用，命令未执行' },
    { tool: 'write_file', input: { path: 'recovered.txt', content: 'approved-write', createOnly: true } },
    { text: '文件已保存' },
    { tool: 'exec_command', input: { command } },
    { text: '命令已在恢复目录完成' },
    { text: '重启后仍保留工作区和对话' },
  ])
  const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: data, EDEN_AGENT_PORT: '0',
    EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(root, 'terminal-settings.json') }, root), model: model.config }
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let socket: WebSocket | undefined
  t.after(async () => {
    socket?.terminate()
    await server?.close()
    await model.close()
    await rm(root, { recursive: true, force: true })
  })
  server = await startServer(config)
  socket = await connect(server.port, config.token)
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/readyz`)).status, 200)
  assert.equal((await request<{ id: string }>(socket, 'session.read', { sessionId })).id, sessionId)
  const info = await request(socket, 'workspace.info', { sessionId })
  assert.equal(info.status, 'missing')
  assert.equal(info.path, missing)
  assert.equal(info.kind, 'external')
  await request(socket, 'turn.start', { sessionId, text: '先普通聊天', idempotencyKey: 'chat' })
  await server.sessions.waitForIdle(sessionId)
  assert.equal(model.requests.length, 1)
  assert.ok(server.sessions.repository.events.list(sessionId, '0', 1000).some(event => event.kind === 'turn.completed'))
  t.diagnostic(`Chat finished after ${Date.now() - started}ms`)

  await request(socket, 'turn.start', { sessionId, text: '检查目录失效时的命令拒绝', idempotencyKey: 'blocked-command' })
  await server.sessions.waitForIdle(sessionId)
  assert.equal(model.requests.length, 4)
  assert.equal((await request<unknown[]>(socket, 'permission.list', { sessionId })).length, 0)
  await assert.rejects(stat(missing), { code: 'ENOENT' })
  const operations = server.sessions.repository.database.connection.prepare('SELECT state FROM tool_operations WHERE session_id=?').all(sessionId)
  assert.ok(operations.some(operation => operation.state === 'failed'))
  t.diagnostic(`Missing-workspace tool checks finished after ${Date.now() - started}ms`)

  await request(socket, 'workspace.switch', { sessionId, path: recovered })
  assert.equal((await request(socket, 'workspace.info', { sessionId })).status, 'ready')
  await request(socket, 'turn.start', { sessionId, text: '写入恢复后的文件', idempotencyKey: 'approved-file' })
  await assert.rejects(stat(path.join(recovered, 'recovered.txt')), { code: 'ENOENT' })
  await approve(socket, sessionId, 'workspace.write')
  await server.sessions.waitForIdle(sessionId)
  assert.equal(await readFile(path.join(recovered, 'recovered.txt'), 'utf8'), 'approved-write')
  t.diagnostic(`Approved file write finished after ${Date.now() - started}ms`)
  await request(socket, 'turn.start', { sessionId, text: '在恢复目录执行命令', idempotencyKey: 'approved-command' })
  await approve(socket, sessionId, 'command.execute')
  await server.sessions.waitForIdle(sessionId)
  assert.equal(await readFile(path.join(recovered, 'command-output.txt'), 'utf8'), 'command-recovered')
  assert.equal(model.requests.length, 8)
  assert.equal(server.sessions.faultCount(), 0)
  t.diagnostic(`Approved command finished after ${Date.now() - started}ms`)
  socket.terminate()
  await server.close()
  server = await startServer(config)
  t.diagnostic(`Host restarted after ${Date.now() - started}ms`)
  socket = await connect(server.port, config.token)
  const restored = await request(socket, 'workspace.info', { sessionId })
  assert.equal(restored.path, recovered)
  assert.equal(restored.kind, 'external')
  assert.equal(restored.status, 'ready')
  await request(socket, 'turn.start', { sessionId, text: '确认重启后历史', idempotencyKey: 'after-restart' })
  await server.sessions.waitForIdle(sessionId)
  assert.equal(model.requests.length, 9)
  assert.match(JSON.stringify(model.requests[8]), /文件已保存/)
  assert.equal(await readFile(path.join(recovered, 'recovered.txt'), 'utf8'), 'approved-write')
})
