import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { tokenProtocolPrefix, websocketProtocol } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'
import { accountKey } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'

export interface WorkspaceInfo {
  name: string
  path: string
  status: 'ready' | 'missing' | 'inaccessible' | 'unselected' | 'invalid'
  kind: 'managed' | 'external' | 'none'
}

interface RpcReply<T> { result: T; error: { message: string } | null }

export function workspaceRpc<T = unknown>(socket: WebSocket, method: string, params: unknown = {}): Promise<RpcReply<T>> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive)
      reject(new Error(`RPC timed out: ${method}`))
    }, 10000)
    const receive = (data: Buffer) => {
      const value = JSON.parse(data.toString()) as RpcReply<T> & { id?: string }
      if (value.id !== id) return
      clearTimeout(timer)
      socket.off('message', receive)
      resolve(value)
    }
    socket.on('message', receive)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

export async function workspaceResult<T = unknown>(socket: WebSocket, method: string, params: unknown = {}): Promise<T> {
  const response = await workspaceRpc<T>(socket, method, params)
  assert.equal(response.error, null, `${method}: ${response.error?.message ?? ''}`)
  return response.result
}

export async function workspaceStartupFixture(context: TestContext) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'eden-workspace-startup-'))
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  const sockets = new Set<WebSocket>()
  const core = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Token /, '')
    const id = token === 'account-a' ? '101' : token === 'account-b' ? '202' : token === 'account-c' ? '303' : undefined
    response.writeHead(id ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(id ? { id } : { error: 'unauthorized' }))
  })
  const stop = async () => {
    for (const socket of sockets) socket.terminate()
    sockets.clear()
    const running = server
    server = undefined
    await running?.close()
  }
  context.after(async () => {
    try { await stop() }
    finally {
      core.closeAllConnections()
      await new Promise<void>(resolve => core.close(() => resolve()))
      assert.ok(path.dirname(temporaryRoot) === path.resolve(tmpdir()) && path.basename(temporaryRoot).startsWith('eden-workspace-startup-'))
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
  core.listen(0, '127.0.0.1')
  await once(core, 'listening')
  const coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`
  const token = 'workspace-startup-regression-token'.repeat(2)
  const accountRoot = (dataRoot: string, userId: string) => path.join(dataRoot, 'accounts',
    createHash('sha256').update(accountKey(coreUrl, userId)).digest('hex'))
  return {
    temporaryRoot, accountRoot, stop,
    async start(dataRoot: string) {
      assert.equal(server, undefined)
      const config = loadConfig({ EDEN_AGENT_RUNTIME_ORIGIN: 'mon', EDEN_AGENT_DATA_ROOT: dataRoot,
        EDEN_AGENT_PORT: '0', MON_CORE_BASE_URL: coreUrl, EDEN_AGENT_CAPABILITY_TOKEN: token,
        EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(temporaryRoot, 'terminal-settings.json') }, temporaryRoot)
      server = await startServer(config)
    },
    async connect(coreToken: string) {
      assert.ok(server)
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, [websocketProtocol, tokenProtocolPrefix + token])
      sockets.add(socket)
      await once(socket, 'open')
      await workspaceResult(socket, 'initialize', { protocolVersion: 2, runtimeOrigin: 'mon', clientName: 'workspace-regression',
        clientVersion: '1', capabilities: [], coreToken })
      return socket
    },
    async assertReady(): Promise<void> {
      assert.ok(server)
      for (const endpoint of ['/healthz', '/readyz']) {
        const response: Response = await fetch(`http://127.0.0.1:${server.port}${endpoint}`)
        assert.equal(response.status, 200, endpoint)
        const body = await response.json() as { checks: { accounts: boolean } }
        assert.equal(body.checks.accounts, true, endpoint)
      }
    },
    async seedLegacy(dataRoot: string, userId: string, workspace: string) {
      const directory = accountRoot(dataRoot, userId)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'account.json'), JSON.stringify({
        key: accountKey(coreUrl, userId), userId, coreBaseUrl: coreUrl,
      }))
      const database = new EdenDatabase(path.join(directory, 'storage', 'eden-agent.db'), 'mon')
      try {
        database.connection.prepare('INSERT INTO runtime_settings VALUES(?,?,?)')
          .run('workspace.root', JSON.stringify(workspace), Date.now())
      } finally { database.close() }
      return path.join(directory, 'storage', 'eden-agent.db')
    },
    async seedSessions(databasePath: string, selections: Record<string, unknown>[]) {
      const account = JSON.parse(await readFile(path.join(path.dirname(databasePath), '..', 'account.json'), 'utf8')) as { key: string }
      const database = new EdenDatabase(databasePath, 'mon'), sessions = new SessionRepository(database, 'mon')
      try {
        return selections.map((settings, index) => {
          const session = sessions.create(`客户旧会话 ${index}`)
          sessions.ownership.assign(session.id, account.key)
          database.connection.prepare('INSERT INTO session_workspaces(session_id,settings_json,updated_at) VALUES(?,?,?)')
            .run(session.id, JSON.stringify(settings), Date.now())
          return session.id
        })
      } finally { database.close() }
    },
  }
}
