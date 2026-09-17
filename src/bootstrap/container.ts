import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { attachWebsocket } from "../transport/websocket/upgrade.ts"
import { AccountHttp } from "../transport/http/account-dispatch.ts"
import { healthHandler } from "../transport/http/health.ts"
import { acquireProcessLock } from "./process-lock.ts"
import { persistToken, type ServerConfig } from "./config.ts"
import { AccountRuntimes } from "./account-runtimes.ts"

export async function startServer(config: ServerConfig) {
  // Local's sole runtime owns its lock; Mon owns a parent lock plus one per-account storage lock.
  const release = config.origin === "mon" ? acquireProcessLock(config.dataRoot) : () => {}
  const runtimes = new AccountRuntimes(config)
  try {
    await runtimes.start()
  } catch (error) {
    await runtimes.close()
    release()
    throw error
  }
  const dispatch = new AccountHttp(config, runtimes)
  const health = healthHandler(config.origin, () => ({
    model: Boolean(config.model),
    sessionFaults: 0,
    memoryExtraction: true,
    accounts: runtimes.ready(),
  }))
  const http = createServer((request, response) => {
    if (dispatch.handle(request, response)) return
    if (config.origin === "local") runtimes.defaultRuntime().health(request, response)
    else health(request, response)
  })
  const websocket = attachWebsocket(http, config, (token) => runtimes.resolve(token))
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject)
      http.listen(config.port, config.host, () => {
        http.removeListener("error", reject)
        resolve()
      })
    })
    persistToken(config)
  } catch (error) {
    websocket.close()
    await dispatch.close()
    await runtimes.close()
    release()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    port: (http.address() as AddressInfo).port,
    get sessions() {
      return runtimes.defaultRuntime().services.sessions
    },
    get plugins() {
      return runtimes.defaultRuntime().services.plugins
    },
    get permissions() {
      return runtimes.defaultRuntime().services.permissions
    },
    get memoryExtractions() {
      return runtimes.defaultRuntime().services.memoryExtractions
    },
    close(): Promise<void> {
      closing ??= (async () => {
        for (const client of websocket.clients) client.terminate()
        await dispatch.close()
        websocket.close()
        http.closeAllConnections()
        await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
        try {
          await runtimes.close()
        } finally {
          release()
        }
      })()
      return closing
    },
  }
}
