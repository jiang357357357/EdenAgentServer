import { createServer, type Socket } from 'node:net'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { desktopControlEventSchema, type DesktopControlEvent } from '@eden/api'
import { brokerPaths } from './broker-paths.ts'
import { jsonLines, send } from './framing.ts'
import { createCuaDriver } from './cua-driver.ts'
import { startInputObserver } from './input-observer.ts'
import { InputArbiter } from './input-arbiter.ts'
import { DesktopExecutor } from './desktop-executor.ts'
import { DesktopError, type DesktopDriver, type InputObserver, type DesktopInputCallback } from './contracts.ts'
import { cuaOperationTimeout } from './cua-timeout.ts'
import { cuaCatalog } from './cua-catalog.ts'
import { publishBrokerRegistration } from './broker-registration.ts'

const requestSchema = z.object({ id: z.string().min(1).max(80), type: z.enum(['hello', 'status', 'control', 'execute', 'cancel', 'release']),
  token: z.string().max(128).optional(), protocol: z.literal('eden.desktop.3').optional(),
  action: z.enum(['pause', 'resume', 'stop']).optional(), session: z.string().uuid().optional(),
  context: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  name: z.string().max(80).optional(), input: z.record(z.string(), z.unknown()).optional(), requestId: z.string().max(80).optional() }).strict()
type Request = z.infer<typeof requestSchema>
interface Peer { owner: string; authorized: boolean; socket: Socket; scopes: Map<string, DesktopExecutor>; requests: Map<string, Request>; cancelled: Set<string> }
function reply(socket: Socket, value: unknown) {
  if (socket.destroyed) return
  try { send(socket, value) } catch { socket.destroy() }
}
function cancelRequests(peer: Peer, requestId?: string, session?: string) {
  for (const request of peer.requests.values()) if (request.type === 'execute'
    && (!requestId || request.id === requestId) && (!session || request.session === session)) peer.cancelled.add(request.id)
}
export interface BrokerOptions {
  driver?: () => Promise<DesktopDriver>
  observer?: (input: DesktopInputCallback) => Promise<InputObserver>
  idleMs?: number
  stuck?: () => void
}
export async function serveDesktopBroker(root: string, options: BrokerOptions = {}) {
  const paths = brokerPaths(root), token = randomBytes(32).toString('hex')
  mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  const peers = new Set<Peer>(), inFlight = new Set<Promise<void>>()
  const persist = (paused: boolean, stopped: boolean, control?: DesktopControlEvent) => {
    const staging = `${paths.control}.${process.pid}.tmp`
    writeFileSync(staging, JSON.stringify({ paused, stopped, ...(control ? { control } : {}) }), { mode: 0o600 }); renameSync(staging, paths.control)
  }
  const arbiter = new InputArbiter(persist, () => {
    driver?.terminate?.()
    if (options.stuck) options.stuck(); else process.exit(1)
  }, () => {
    for (const peer of peers) {
      if (arbiter.paused || arbiter.stopped) cancelRequests(peer)
      for (const executor of peer.scopes.values()) executor.invalidate()
    }
  })
  try { const state = z.object({ paused: z.boolean(), stopped: z.boolean(), control: desktopControlEventSchema.optional() }).parse(JSON.parse(readFileSync(paths.control, 'utf8')))
    arbiter.paused = state.paused; arbiter.stopped = state.stopped
    arbiter.controlEvent = state.control ?? (state.stopped || state.paused ? { action: state.stopped ? 'stop' : 'pause', source: 'legacy', changedAt: 0 } : undefined)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') arbiter.control('stop', 'state_corrupt') }
  let driver: DesktopDriver | undefined, observer: InputObserver | undefined, initializing: Promise<void> | undefined
  let closing: Promise<void> | undefined, idle: ReturnType<typeof setTimeout> | undefined
  async function initialize() {
    if (!initializing) initializing = (async () => {
      observer = await (options.observer ?? startInputObserver)((stop, windowId, source) => arbiter.physicalInput(stop, windowId, source))
      try { driver = await (options.driver ?? createCuaDriver)() }
      catch (error) { await observer.close(); observer = undefined; throw error }
    })().catch(error => { initializing = undefined; throw error })
    await initializing
  }
  const server = createServer(socket => {
    if (idle) clearTimeout(idle)
    const peer: Peer = { owner: randomUUID(), authorized: false, socket, scopes: new Map(), requests: new Map(), cancelled: new Set() }
    peers.add(peer)
    socket.on('error', () => socket.destroy())
    const authDeadline = setTimeout(() => { if (!peer.authorized) socket.destroy() }, 3000)
    socket.on('close', () => {
      clearTimeout(authDeadline); peers.delete(peer); arbiter.cancel(peer.owner)
      cancelRequests(peer)
      const cleanup = Promise.allSettled([...peer.scopes.values()].map(executor => executor.release())).then(results => {
        peer.scopes.clear()
        if (results.some(result => result.status === 'rejected')) driver?.terminate?.()
      }).finally(() => inFlight.delete(cleanup))
      inFlight.add(cleanup)
      if (!peers.size && !closing) idle = setTimeout(() => { void close() }, options.idleMs ?? 60000)
    })
    jsonLines(socket, 128 * 1024, value => {
      const request = requestSchema.parse(value)
      if (peer.requests.has(request.id) || peer.requests.size >= 128) { socket.destroy(); return }
      peer.requests.set(request.id, request)
      const work = dispatch(peer, request).then(result => {
        reply(socket, { id: request.id, result })
      }, error => {
        reply(socket, { id: request.id, error: { message: error instanceof DesktopError ? error.message : '桌面服务调用失败，请检查驱动与窗口状态',
          code: error instanceof DesktopError ? error.code : 'DESKTOP_FAILED', outcome: error instanceof DesktopError ? error.toolOutcome : request.type === 'execute' ? 'unknown' : 'failed',
          ...(error instanceof DesktopError && error.diagnostics ? { diagnostics: error.diagnostics } : {}) } })
      }).finally(() => { peer.requests.delete(request.id); peer.cancelled.delete(request.id); inFlight.delete(work) })
      inFlight.add(work)
    })
  })
  function authenticate(peer: Peer, request: Request) {
    const supplied = Buffer.from(request.token ?? '')
    if (peer.authorized || request.protocol !== 'eden.desktop.3' || supplied.length !== token.length
      || !timingSafeEqual(supplied, Buffer.from(token))) throw new DesktopError('桌面控制认证失败')
    peer.authorized = true
    return { protocol: 'eden.desktop.3' }
  }
  async function dispatch(peer: Peer, request: Request): Promise<unknown> {
    if (request.type === 'hello') return authenticate(peer, request)
    if (!peer.authorized) throw new DesktopError('桌面控制尚未认证')
    if (request.type === 'release') {
      if (!request.session) throw new DesktopError('缺少待清理的桌面会话')
      cancelRequests(peer, undefined, request.session)
      arbiter.cancel(peer.owner, undefined, request.session)
      const selected = [...peer.scopes].filter(([key]) => key.startsWith(`${request.session}.`))
      for (const [key] of selected) peer.scopes.delete(key)
      await Promise.all(selected.map(([, executor]) => executor.release()))
      return {}
    }
    if (request.type === 'cancel') {
      cancelRequests(peer, request.requestId)
      arbiter.cancel(peer.owner, request.requestId); return {}
    }
    if (request.type === 'control') {
      if (!request.action) throw new DesktopError('缺少桌面控制动作')
      arbiter.control(request.action)
    }
    if (request.type === 'status' || request.type === 'control') return arbiter.status(peer.owner, observer?.available ?? false)
    return execute(peer, request)
  }
  async function execute(peer: Peer, request: Request): Promise<unknown> {
    if (!request.session || !request.name || !request.input) throw new DesktopError('缺少桌面任务参数')
    await initialize()
    if (!observer?.available) throw new DesktopError('桌面输入观察器不可用，已阻止执行', 'OBSERVER_UNAVAILABLE')
    if (peer.cancelled.has(request.id)) throw new DesktopError('桌面请求在准备期间已取消', 'DESKTOP_CANCELLED', 'cancelled')
    if (peer.socket.destroyed) throw new DesktopError('桌面调用方已断开', 'DESKTOP_DISCONNECTED', 'cancelled')
    const key = `${request.session}.${request.context ?? 'legacy'}`
    let executor = peer.scopes.get(key)
    if (!executor) {
      await evictIdleScope(peer)
      const privateScope = `${peer.owner}.${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
      executor = new DesktopExecutor(driver!.scoped?.(privateScope) ?? driver!, observer!); peer.scopes.set(key, executor)
    }
    const selected = executor
    return arbiter.run({ owner: peer.owner, session: request.session, id: request.id }, request.name, selected.title(request.input),
      usesGlobalInput(request.name, request.input),
      signal => selected.execute(request.name!, request.input!, signal), selected.windowId(request.input), cuaOperationTimeout(request.name, request.input))
  }
  async function close() {
    closing ??= (async () => {
      if (idle) clearTimeout(idle)
      for (const peer of peers) { arbiter.cancel(peer.owner); peer.socket.destroy() }
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.allSettled([...inFlight])
      await driver?.close(); await observer?.close()
    })()
    return closing
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.endpoint, () => { server.removeListener('error', reject); resolve() }) })
  try { await publishBrokerRegistration(paths.token, token) }
  catch (error) { await close(); throw error }
  return { close, arbiter, endpoint: paths.endpoint }
}

function usesGlobalInput(name: string, input: Record<string, unknown>) {
  if (name.startsWith('cua_')) return input.delivery_mode === 'foreground'
    || cuaCatalog.find(tool => tool.name === name.slice(4))?.annotations.readOnlyHint !== true
  return input.delivery === 'foreground' || name === 'desktop_window' || name === 'desktop_launch'
}

async function evictIdleScope(peer: Peer) {
  if (peer.scopes.size < 32) return
  const active = new Set([...peer.requests.values()].filter(request => request.type === 'execute')
    .map(request => `${request.session}.${request.context ?? 'legacy'}`))
  const idle = [...peer.scopes].find(([key]) => !active.has(key))
  if (!idle) throw new DesktopError('桌面执行上下文数量超过限制，请等待当前操作结束', 'DESKTOP_BUSY')
  peer.scopes.delete(idle[0]); await idle[1].release()
}
