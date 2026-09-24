import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import { SessionRepository } from "../../../src/modules/sessions/session-repository.ts"
import { loadConfig } from "../../../src/bootstrap/config.ts"
import { startServer } from "../../../src/bootstrap/container.ts"

async function unusedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test("Mon binds its health socket before a slow legacy account recovery finishes", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eden-mon-startup-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const core = createServer((_request, response) => {
    setTimeout(() => response.writeHead(401).end(), 500)
  })
  core.listen(0, "127.0.0.1")
  await once(core, "listening")
  context.after(async () => {
    core.closeAllConnections()
    await new Promise<void>((resolve) => core.close(() => resolve()))
  })
  const coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`
  const database = new EdenDatabase(path.join(root, "eden-agent.db"), "mon")
  const session = new SessionRepository(database, "mon").create("legacy")
  database.connection
    .prepare("INSERT INTO mon_connections(session_id,core_base_url,core_token,updated_at) VALUES(?,?,?,?)")
    .run(session.id, coreUrl, "saved-token", Date.now())
  database.close()

  const port = await unusedPort()
  const config = loadConfig({
    EDEN_AGENT_RUNTIME_ORIGIN: "mon",
    EDEN_AGENT_DATA_ROOT: root,
    EDEN_AGENT_PORT: String(port),
    EDEN_AGENT_CAPABILITY_TOKEN: "x".repeat(32),
    MON_CORE_BASE_URL: coreUrl,
  })
  let settled = false
  const starting = startServer(config).finally(() => {
    settled = true
  })
  let response: Response | undefined
  for (let attempt = 0; attempt < 20 && !response; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/healthz`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.equal(response?.status, 200)
  assert.equal(settled, false)
  const body = (await response!.json()) as { checks: { accounts: boolean } }
  assert.equal(body.checks.accounts, false)
  const server = await starting
  await server.close()
})
