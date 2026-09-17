import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ServerConfig } from "../../bootstrap/config.ts"
import type { AccountRuntimes } from "../../bootstrap/account-runtimes.ts"

export class AccountHttp {
  private readonly tasks = new Set<Promise<void>>()
  private closing = false
  constructor(
    private readonly config: ServerConfig,
    private readonly runtimes: AccountRuntimes,
  ) {}
  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = request.url ?? "",
      blob = url === "/blobs" || url.startsWith("/blobs/"),
      internal = url === "/internal/self-awake/run" || url === "/internal/self-awake/status"
    if (!blob && !internal) return false
    if (this.closing || this.tasks.size >= 64) {
      this.reject(response, 503)
      return true
    }
    const task = this.dispatch(request, response, internal).catch(() => this.reject(response, 401))
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task))
    return true
  }
  private async dispatch(request: IncomingMessage, response: ServerResponse, internal: boolean) {
    if (internal) {
      if (this.config.origin === "local") {
        this.runtimes.defaultRuntime().selfAwakeHttp.handle(request, response)
        return
      }
      const account = this.runtimes.serviceAccount()
      if (!account) {
        this.reject(response, 503)
        return
      }
      const runtime = await this.runtimes.get(account)
      runtime.selfAwakeHttp.handle(request, response)
      return
    }
    if (!this.preflight(request, response)) return
    const token = Buffer.from((request.headers.authorization ?? "").replace(/^Bearer /, "")),
      expected = Buffer.from(this.config.token)
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      this.reject(response, 401)
      return
    }
    const runtime = await this.runtimes.resolve(String(request.headers["x-eden-core-token"] ?? ""))
    if (this.closing || request.aborted) {
      this.reject(response, 503)
      return
    }
    runtime.blobHttp.handle(request, response)
  }
  private preflight(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin
    if (origin && !this.config.allowedOrigins.includes(origin)) {
      this.reject(response, 403)
      return false
    }
    if (origin) response.setHeader("access-control-allow-origin", origin)
    response.setHeader("vary", "Origin")
    if (request.method === "OPTIONS") {
      const headers = String(request.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      if (
        !origin ||
        !["GET", "POST"].includes(String(request.headers["access-control-request-method"])) ||
        headers.some((value) => !["authorization", "content-type", "x-eden-core-token"].includes(value))
      ) {
        this.reject(response, 403)
        return false
      }
      response
        .writeHead(204, {
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "authorization, content-type, x-eden-core-token",
        })
        .end()
      return false
    }
    return true
  }
  private reject(response: ServerResponse, status: number) {
    if (!response.destroyed && !response.writableEnded)
      response
        .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ error: "Account request unavailable or unauthorized" }))
  }
  async close() {
    this.closing = true
    await Promise.allSettled(this.tasks)
  }
}
