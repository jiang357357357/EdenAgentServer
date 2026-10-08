import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { Agent, createServer, get } from 'node:http'
import type { ClientRequest, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { EdenDatabase } from '@eden/store'
import { rpcMethods } from '@eden/api'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'
import { healthHandler } from '../../../src/transport/http/health.ts'

test('twenty real HTTP list requests share the event loop with health and stop reading on client disconnect',
  { timeout: 120_000 }, async t => {
    const database = new EdenDatabase(':memory:', 'mon')
    const repository = new SessionRepository(database, 'mon')
    const service = new SessionService(repository, undefined)
    const listAgent = new Agent({ keepAlive: true, maxSockets: 1 })
    const healthAgent = new Agent({ keepAlive: true, maxSockets: 1 })
    let stopped = false
    let healthLoop: Promise<void> | undefined
    let activeList: string | undefined
    let readCount = 0
    let cancelRequest: ClientRequest | undefined
    let cancelObserved!: (value: { aborted: boolean; name: string; reads: number }) => void
    const cancelled = new Promise<{ aborted: boolean; name: string; reads: number }>(resolve => { cancelObserved = resolve })
    const handledDuring = new Map<string, number>()
    const failures: string[] = []
    const sockets = new Set<Socket>()
    let socketCloses = 0
    const health = healthHandler('mon', () => ({ model: false, sessionFaults: 0, memoryExtraction: true }))
    const runList = async (label: string, response: ServerResponse) => {
      activeList = label; readCount = 0
      const controller = new AbortController()
      const disconnected = () => { if (!response.writableFinished) controller.abort() }
      response.once('close', disconnected)
      try {
        const result = await sessionRoutes(service, controller.signal)['session.list']!({ limit: 1000 })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Unknown'
        if (label === 'cancel') cancelObserved({ aborted: controller.signal.aborted, name, reads: readCount })
        else failures.push(String(error))
        if (!response.destroyed) response.writeHead(500).end()
      } finally {
        response.off('close', disconnected)
        activeList = undefined
      }
    }
    // This temporary HTTP adapter calls the production RPC handler; it is not a complete Agent server.
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/fixture/session-list/')) {
        void runList(request.url.slice('/fixture/session-list/'.length), response)
      } else {
        if (activeList) handledDuring.set(activeList, (handledDuring.get(activeList) ?? 0) + 1)
        health(request, response)
      }
    })
    server.keepAliveTimeout = 60_000
    t.after(async () => {
      stopped = true
      await healthLoop
      listAgent.destroy(); healthAgent.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await service.close()
      database.close()
    })
    for (let index = 0; index < 1200; index++) {
      const session = repository.create(`HTTP list fixture ${index}`, [{ assistantId: 1 }])
      database.connection.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(index, session.id)
    }
    const read = repository.read.bind(repository)
    t.mock.method(repository, 'read', (id: string) => {
      if (++readCount === 25 && activeList === 'cancel') {
        setImmediate(() => cancelRequest?.destroy(new Error('Intentional fixture list disconnect')))
      }
      return read(id)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const request = (pathname: string, agent: Agent, created?: (value: ClientRequest) => void) => new Promise<{ body: unknown; elapsedMs: number }>((resolve, reject) => {
      const start = performance.now()
      const pending = get({ host: '127.0.0.1', port, path: pathname, agent }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('error', reject)
        response.on('end', () => {
          try { assert.equal(response.statusCode, 200); resolve({ body: JSON.parse(body), elapsedMs: performance.now() - start }) }
          catch (error) { reject(error) }
        })
      })
      pending.on('socket', socket => {
        if (sockets.has(socket)) return
        sockets.add(socket)
        socket.once('close', () => { socketCloses++ })
      })
      pending.setTimeout(10_000, () => pending.destroy(new Error('Temporary HTTP request timed out')))
      pending.on('error', reject)
      created?.(pending)
    })
    // Warm both independent sockets after seeding, before starting timing and disconnect counters.
    await request('/healthz', listAgent)
    await request('/healthz', healthAgent)
    const latencies: number[] = []
    healthLoop = (async () => {
      while (!stopped) {
        const response = await request('/healthz', healthAgent)
        assert.equal((response.body as { status: string }).status, 'ok')
        latencies.push(response.elapsedMs)
        await delay(1)
      }
    })().catch(error => { failures.push(String(error)); stopped = true })
    const start = performance.now()
    for (let round = 0; round < 20; round++) {
      const response = await request(`/fixture/session-list/${round}`, listAgent)
      const sessions = rpcMethods['session.list'].result.parse(response.body)
      assert.equal(sessions.length, 1000)
      assert.equal(sessions[0]!.title, 'HTTP list fixture 1199')
      assert.equal(sessions.at(-1)!.title, 'HTTP list fixture 200')
      assert.ok((handledDuring.get(String(round)) ?? 0) > 0, 'A health request must be served before each list completes')
    }
    const listingMs = Math.round(performance.now() - start)
    stopped = true
    await healthLoop
    assert.deepEqual(failures, [])
    assert.equal(socketCloses, 0, 'Neither keep-alive client disconnects during the twenty ordinary rounds')
    assert.ok(latencies.length >= 20)

    await assert.rejects(request('/fixture/session-list/cancel', listAgent, value => { cancelRequest = value }), /Intentional fixture list disconnect/)
    const cancellation = await cancelled
    assert.deepEqual({ name: cancellation.name, aborted: cancellation.aborted }, { name: 'AbortError', aborted: true })
    assert.ok(cancellation.reads >= 25 && cancellation.reads < 1000, 'Connection shutdown stops the remaining summary reads')
    assert.equal(((await request('/healthz', healthAgent)).body as { status: string }).status, 'ok')
    assert.deepEqual(failures, [])
    const sorted = latencies.toSorted((a, b) => a - b)
    const roundMs = (value: number) => Number(value.toFixed(3))
    t.diagnostic(JSON.stringify({ sessions: 1200, summariesPerList: 1000, rounds: 20, listingMs,
      healthSamples: sorted.length, healthMinMs: roundMs(sorted[0]!), healthP95Ms: roundMs(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
      healthMaxMs: roundMs(sorted.at(-1)!), healthHandledBeforeListCompletion: [...handledDuring.entries()].filter(([key]) => key !== 'cancel'),
      ordinaryErrors: failures.length, ordinaryDisconnects: 0, cancellation,
      scope: 'Real loopback HTTP healthHandler and HTTP fixture adapter invoking production sessionRoutes; in-memory SQLite; no complete Server, WebSocket or Electron soak.' }))
  })
