import { AccountConnection, AccountAuthentication, withAccount } from "../../modules/accounts/index.ts"
import { timingSafeEqual } from "node:crypto"
import type { Server as HttpServer, IncomingMessage } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { tokenProtocolPrefix, websocketProtocol, initializeSchema, rpcRequestSchema } from "@eden/api"
import type { JsonValue } from "@eden/api"
import type { ServerConfig } from "../../bootstrap/config.ts"
import type { RuntimeScope } from "../../bootstrap/runtime-scope.ts"
import { RpcRouter } from "../rpc/router.ts"
import { sessionRoutes } from "../rpc/session.routes.ts"
import { AccountEventDelivery } from "./account-event-delivery.ts"
import { reminderEventNotifier } from "./reminder-event-notifier.ts"
import { sendWebsocketEvent } from "./event-sender.ts"
import { assertSessionChannel, priorityRequest } from "./session-channel.ts"

function authenticated(request: IncomingMessage, config: ServerConfig): boolean {
  const origin = request.headers.origin
  if (origin && !config.allowedOrigins.includes(origin)) return false
  const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim())
  if (!protocols.includes(websocketProtocol)) return false
  const token = protocols.find((value) => value.startsWith(tokenProtocolPrefix))?.slice(tokenProtocolPrefix.length)
  if (!token) return false
  const expected = Buffer.from(config.token),
    supplied = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function attachWebsocket(
  server: HttpServer,
  config: ServerConfig,
  resolve: (token: string) => Promise<RuntimeScope>,
): WebSocketServer {
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(websocketProtocol) ? websocketProtocol : false),
  })
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost"),
      voice = url.pathname === "/voice/stt/realtime"
    if ((!voice && request.url !== "/rpc") || !authenticated(request, config)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    if (!voice) {
      websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client))
      return
    }
    const encoded = (request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .find((value) => value.startsWith("eden-core."))
      ?.slice(10)
    void resolve(encoded ? Buffer.from(encoded, "base64url").toString("utf8") : "")
      .then((runtime) => {
        return withAccount(runtime.config.account, async () => {
          const id = url.searchParams.get("session_id") ?? ""
          runtime.services.repository.read(id)
          const connect = await runtime.services.realtimeVoice.prepare(id)
          websocket.handleUpgrade(request, socket, head, connect)
        })
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
        socket.destroy()
      })
  })
  websocket.on("connection", (client) => connectRpc(client, config, resolve))
  return websocket
}

function connectRpc(client: WebSocket, config: ServerConfig, resolve: (token: string) => Promise<RuntimeScope>) {
  const lifetime = new AbortController()
  let router: RpcRouter | undefined,
    initialized = false,
    pendingCount = 0
  let unsubscribe: (() => void) | undefined, refresh: ReturnType<typeof setInterval> | undefined
  let releaseSharedWorkspace: (() => void) | undefined
  let eventDelivery: AccountEventDelivery | undefined
  let pending = Promise.resolve()
  let beginEvents: (() => void) | undefined
  const sendSerialized = (serialized: string) => {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount > 4 * 1024 * 1024) {
      eventDelivery?.dispose()
      client.close(1013, "Event stream lagged")
      return
    }
    client.send(serialized)
  }
  const send = (value: unknown) => sendSerialized(JSON.stringify(value))
  const bind = async (token: string, input: ReturnType<typeof initializeSchema.parse>) => {
    const runtime = await resolve(token)
    if (client.readyState !== WebSocket.OPEN) throw new Error("Connection closed during account initialization")
    const account =
      config.origin === "mon"
        ? new AccountConnection(
            new AccountAuthentication(
              runtime.config.coreBaseUrl ?? config.monIdentity?.coreBaseUrl ?? "http://127.0.0.1:40011",
            ),
            async () => {},
          )
        : undefined
    const delivery = new AccountEventDelivery(account, value => sendWebsocketEvent(client, value),
      (code, reason) => { releaseSharedWorkspace?.(); client.close(code, reason) },
      ranges => withAccount(runtime.config.account, () => runtime.services.repository.events.nextPending(ranges)))
    eventDelivery = delivery
    const sessionId = input.sessionId
    const firstSequence = sessionId ? withAccount(runtime.config.account, () => {
      runtime.services.repository.readMetadata(sessionId)
      const latest = runtime.services.repository.events.latestSequence(sessionId)
      if (input.afterSeq !== undefined && BigInt(input.afterSeq) > latest) throw new Error("Session cursor is ahead of the durable history")
      return input.afterSeq ?? String(latest)
    }) : undefined
    const handlers = { ...sessionRoutes(runtime.services.sessions, lifetime.signal), ...runtime.routes }
    const routes = Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        (params: JsonValue) => {
          assertSessionChannel(sessionId, method, params)
          return account ? delivery.refresh().then(() => account.run(params, () => handler(params))) : handler(params)
        },
      ]),
    )
    const next = new RpcRouter(
      config.origin,
      routes,
      account
        ? async (token) => {
            await account.initialize(token)
            if (account.account?.key !== runtime.config.account?.key) throw new Error("Account runtime mismatch")
            if (client.readyState !== WebSocket.OPEN) throw new Error("Connection closed during account initialization")
            if (!sessionId) releaseSharedWorkspace = runtime.services.sharedWorkspace.attach(async () => {
              await account.refresh()
              if (client.readyState !== WebSocket.OPEN || !account.account) throw new Error("Account connection closed")
              return { accountKey: account.account.key, coreBaseUrl: account.account.coreBaseUrl, token }
            })
          }
        : undefined,
      config.workspaceId,
    )
    if (account)
      refresh = setInterval(() => {
        if (initialized && account.account)
          void delivery.refresh().catch(() => {}) // Delivery closes and clears queued events on failure.
      }, 30000)
    const discovered = new Set<string>()
    const notifyReminder = reminderEventNotifier(config.origin, () => delivery.refresh(),
      () => initialized && !lifetime.signal.aborted, send)
    unsubscribe = runtime.services.repository.events.subscribe((event) => {
      if (!initialized || (sessionId && event.sessionId !== sessionId)) return
      if (input.eventMode === "reminders") { notifyReminder(event); return }
      if (input.eventMode !== "discovery") { delivery.publish(event); return }
      if (discovered.has(event.sessionId) && !['turn.started', 'input.queued', 'permission.requested',
        'question.requested', 'media.requested', 'workspace.changed', 'session.archive_updated'].includes(event.kind)) return
      discovered.add(event.sessionId)
      // Only the first event announces a session. Token streams never enter the control socket.
      void delivery.refresh().then(() => {
        if (!initialized || lifetime.signal.aborted) return
        send({ jsonrpc: "2.0", method: "session.discovered", params: {
          sessionId: event.sessionId, afterSeq: String(BigInt(event.seq) - 1n),
        } })
      }).catch(() => {}) // AccountEventDelivery owns authentication failure and connection closure.
    })
    beginEvents = () => {
      if (sessionId && firstSequence !== undefined) withAccount(runtime.config.account, () => {
        delivery.replay(sessionId, firstSequence, String(runtime.services.repository.events.latestSequence(sessionId)))
      })
    }
    return next
  }
  client.on("message", (data, binary) => {
    if (binary) {
      client.close(1008, "Request queue limit exceeded")
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(data.toString())
    } catch {
      send({ jsonrpc: "2.0", id: null, result: null, error: { code: -32700, message: "Invalid JSON" } })
      return
    }
    const independent = initialized && (priorityRequest(raw) ||
      (typeof raw === "object" && raw !== null && "method" in raw && raw.method === "voice.tts.synthesize"))
    if (++pendingCount > (independent ? 72 : 64)) {
      pendingCount--
      client.close(1008, "Request queue limit exceeded")
      return
    }
    const task = (independent ? Promise.resolve() : pending)
      .then(async () => {
        if (client.readyState !== WebSocket.OPEN) return
        try {
          if (!router) {
            const request = rpcRequestSchema.parse(raw)
            if (request.method !== "initialize") throw new Error("Initialize the connection first")
            const input = initializeSchema.parse(request.params)
            if (input.runtimeOrigin !== config.origin) throw new Error("Runtime origin mismatch")
            if (input.workspaceId && input.workspaceId !== config.workspaceId)
              throw new Error('服务属于其他 EDEN 工作区，请使用对应的配置管理和客户端')
            router = await bind(input.coreToken ?? "", input)
          }
          const response = await router.dispatch(raw)
          if (response) {
            send(response)
            if (isInitialized(response)) { initialized = true; beginEvents?.(); beginEvents = undefined }
            else if (!initialized) {
              eventDelivery?.dispose()
              eventDelivery = undefined
              unsubscribe?.()
              unsubscribe = undefined
              releaseSharedWorkspace?.()
              releaseSharedWorkspace = undefined
              clearInterval(refresh)
              router = undefined
            }
          }
        } catch (error) {
          const request = rpcRequestSchema.safeParse(raw)
          send({
            jsonrpc: "2.0",
            id: request.success ? (request.data.id ?? null) : null,
            result: null,
            error: { code: -32001, message: error instanceof Error ? error.message : "Account authentication failed" },
          })
        }
      })
      .finally(() => {
        pendingCount--
      })
    if (!independent) pending = task
    void task.catch(() => client.close(1011, "RPC processing failed"))
  })
  const cleanup = () => {
    lifetime.abort(new Error("RPC connection closed"))
    eventDelivery?.dispose()
    unsubscribe?.()
    releaseSharedWorkspace?.()
    clearInterval(refresh)
  }
  client.on("close", cleanup)
  client.on("error", cleanup)
}

function isInitialized(response: JsonValue): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response) || response.error !== null) return false
  const result = response.result
  return Boolean(result && typeof result === "object" && !Array.isArray(result) && result.serverName)
}
