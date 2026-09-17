import { AccountConnection, AccountAuthentication, withAccount } from "../../modules/accounts/index.ts"
import { timingSafeEqual } from "node:crypto"
import type { Server as HttpServer, IncomingMessage } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { tokenProtocolPrefix, websocketProtocol, initializeSchema, rpcRequestSchema } from "@eden/api"
import type { JsonValue } from "@eden/api"
import type { ServerConfig } from "../../bootstrap/config.ts"
import type { RuntimeScope } from "../../bootstrap/runtime-scope.ts"
import { RpcRouter } from "../rpc/router.ts"
import { sessionRoutes, wireEvent } from "../rpc/session.routes.ts"

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
        withAccount(runtime.config.account, () => {
          const id = url.searchParams.get("session_id") ?? ""
          runtime.services.repository.read(id)
          const connect = runtime.services.realtimeVoice.prepare(id)
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
  let router: RpcRouter | undefined,
    initialized = false,
    pendingCount = 0
  let unsubscribe: (() => void) | undefined, refresh: ReturnType<typeof setInterval> | undefined
  let pending = Promise.resolve()
  const send = (value: unknown) => {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount > 4 * 1024 * 1024) {
      client.close(1013, "Event stream lagged")
      return
    }
    client.send(JSON.stringify(value))
  }
  const bind = async (token: string) => {
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
    const handlers = { ...sessionRoutes(runtime.services.sessions), ...runtime.routes }
    const routes = Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        (params: JsonValue) => (account ? account.run(params, () => handler(params)) : handler(params)),
      ]),
    )
    const next = new RpcRouter(
      config.origin,
      routes,
      account
        ? async (token) => {
            await account.initialize(token)
            if (account.account?.key !== runtime.config.account?.key) throw new Error("Account runtime mismatch")
          }
        : undefined,
    )
    if (account)
      refresh = setInterval(() => {
        if (account.account)
          void account.refresh().catch(() => client.close(1008, "Core account authentication expired"))
      }, 30000)
    unsubscribe = runtime.services.repository.events.subscribe((event) => {
      if (initialized && (!account || account.active()))
        send({ jsonrpc: "2.0", method: "session.event", params: wireEvent(event) })
    })
    return next
  }
  client.on("message", (data, binary) => {
    if (binary || ++pendingCount > 64) {
      client.close(1008, "Request queue limit exceeded")
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(data.toString())
    } catch {
      pendingCount--
      send({ jsonrpc: "2.0", id: null, result: null, error: { code: -32700, message: "Invalid JSON" } })
      return
    }
    const independent =
      initialized &&
      typeof raw === "object" &&
      raw !== null &&
      "method" in raw &&
      (raw.method === "voice.tts.cancel" || raw.method === "voice.tts.synthesize")
    const task = (independent ? Promise.resolve() : pending)
      .then(async () => {
        if (client.readyState !== WebSocket.OPEN) return
        try {
          if (!router) {
            const request = rpcRequestSchema.parse(raw)
            if (request.method !== "initialize") throw new Error("Initialize the connection first")
            const input = initializeSchema.parse(request.params)
            if (input.runtimeOrigin !== config.origin) throw new Error("Runtime origin mismatch")
            router = await bind(input.coreToken ?? "")
          }
          const response = await router.dispatch(raw)
          if (response) {
            send(response)
            if (isInitialized(response)) initialized = true
            else if (!initialized) {
              unsubscribe?.()
              unsubscribe = undefined
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
    unsubscribe?.()
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
