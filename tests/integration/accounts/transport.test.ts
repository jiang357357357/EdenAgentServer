import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { websocketProtocol, tokenProtocolPrefix } from "@eden/api"
import { startServer } from "../../../src/bootstrap/container.ts"
import { loadConfig } from "../../../src/bootstrap/config.ts"

type Reply = { result: any; error: any }
function rpc(client: WebSocket, method: string, params: unknown = {}): Promise<Reply> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("message", receive)
      reject(new Error(`Timeout ${method}`))
    }, 10000)
    const receive = (data: Buffer) => {
      const value = JSON.parse(data.toString())
      if (value.id !== id) return
      clearTimeout(timer)
      client.off("message", receive)
      resolve(value)
    }
    client.on("message", receive)
    client.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

test("production RPC and Blob HTTP isolate two verified accounts and retain ownership after restart", async (t) => {
  const core = createServer((req, res) => {
    const token = req.headers.authorization
    const id = token === "Token account-a" ? "101" : token === "Token account-b" ? "202" : null
    res
      .writeHead(id ? 200 : 401, { "content-type": "application/json" })
      .end(JSON.stringify(id ? { id } : { error: "unauthorized" }))
  })
  core.listen(0, "127.0.0.1")
  await once(core, "listening")
  const coreUrl = `http://127.0.0.1:${(core.address() as { port: number }).port}`
  const root = await mkdtemp(path.join(tmpdir(), "eden-accounts-"))
  const config = {
    ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: "0", EDEN_AGENT_RUNTIME_ORIGIN: "mon" }),
    monIdentity: { coreBaseUrl: coreUrl, userId: "101", secret: "test-only-secret" },
  }
  let server = await startServer(config)
  const sockets: WebSocket[] = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    await server.close()
    core.closeAllConnections()
    await new Promise<void>((resolve) => core.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  const connect = async (token?: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, [
      websocketProtocol,
      tokenProtocolPrefix + config.token,
    ])
    sockets.push(socket)
    await once(socket, "open")
    const response = await rpc(socket, "initialize", {
      protocolVersion: 2,
      runtimeOrigin: "mon",
      clientName: "test",
      clientVersion: "1",
      capabilities: [],
      ...(token ? { coreToken: token } : {}),
    })
    return { socket, response }
  }
  const denied = await connect()
  assert.ok(denied.response.error)
  assert.ok((await rpc(denied.socket, "session.list")).error)
  const invalid = await connect("invalid")
  assert.ok(invalid.response.error)
  const a = await connect("account-a"),
    b = await connect("account-b")
  assert.equal(a.response.error, null)
  assert.equal(b.response.error, null)
  const receivedA: string[] = [],
    receivedB: string[] = []
  a.socket.on("message", (data) => {
    const value = JSON.parse(data.toString())
    if (value.method === "session.event") receivedA.push(value.params.sessionId)
  })
  b.socket.on("message", (data) => {
    const value = JSON.parse(data.toString())
    if (value.method === "session.event") receivedB.push(value.params.sessionId)
  })
  const first = (await rpc(a.socket, "session.create", { title: "private A" })).result.id
  const second = (await rpc(b.socket, "session.create", { title: "private B" })).result.id
  await rpc(a.socket, "ping")
  await rpc(b.socket, "ping")
  assert.deepEqual(receivedA, [first])
  assert.deepEqual(receivedB, [second])
  assert.deepEqual(
    (await rpc(a.socket, "session.list")).result.map((s: any) => s.id),
    [first],
  )
  assert.deepEqual(
    (await rpc(b.socket, "session.list")).result.map((s: any) => s.id),
    [second],
  )
  for (const method of [
    "session.read",
    "session.context",
    "session.delete",
    "session.close",
    "message.list",
    "event.list",
    "turn.cancel",
    "voice.tts.list_segments",
  ]) {
    assert.ok((await rpc(b.socket, method, { sessionId: first })).error, method)
  }
  assert.ok((await rpc(b.socket, "session.rename", { sessionId: first, title: "stolen" })).error)
  assert.ok(
    (await rpc(b.socket, "model.catalog", { sessionId: second, coreBaseUrl: coreUrl, coreToken: "account-a" })).error,
  )
  const pluginManifest = {
    schemaVersion: 1,
    id: "account-tool",
    name: "Account tool",
    description: "Scoped plugin",
    version: "1.0.0",
    entry: "index.ts",
    tool: {
      name: "account_value",
      description: "Returns the account value",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    permissions: [],
    tests: [{ input: {}, expected: { value: "A" } }],
  }
  const draft = await rpc(a.socket, "plugin.draft.save", {
    manifest: pluginManifest,
    source: "export default () => ({value:'A'})",
  })
  assert.equal(draft.error, null)
  assert.deepEqual((await rpc(b.socket, "plugin.draft.list")).result, [])
  assert.ok((await rpc(b.socket, "plugin.draft.read", { id: "account-tool" })).error)
  const report = await rpc(a.socket, "plugin.test", {
    id: "account-tool",
    expectedDraftRevision: draft.result.draftRevision,
  })
  assert.equal(report.error, null)
  assert.equal(report.result.passed, true)
  assert.equal(
    (await rpc(a.socket, "plugin.install", { id: "account-tool", revision: report.result.revision })).error,
    null,
  )
  assert.equal(
    (await rpc(a.socket, "plugin.activate", { id: "account-tool", revision: report.result.revision })).error,
    null,
  )
  assert.deepEqual((await rpc(b.socket, "plugin.version.list")).result, [])
  assert.equal(
    (
      await rpc(b.socket, "plugin.draft.save", {
        manifest: { ...pluginManifest, tests: [{ input: {}, expected: { value: "B" } }] },
        source: "export default () => ({value:'B'})",
      })
    ).error,
    null,
  )
  assert.match((await rpc(a.socket, "plugin.draft.read", { id: "account-tool" })).result.source, /value:'A'/)
  assert.equal((await rpc(a.socket, "permission.mode.set", { mode: "takeover" })).error, null)
  assert.equal((await rpc(b.socket, "permission.mode.get")).result.mode, "restricted")
  assert.equal(
    (
      await rpc(a.socket, "skill.install", {
        name: "account-note",
        description: "A private skill",
        content: "A private instructions",
      })
    ).error,
    null,
  )
  assert.ok((await rpc(b.socket, "skill.read", { name: "account-note" })).error)
  assert.equal(
    (
      await rpc(b.socket, "skill.install", {
        name: "account-note",
        description: "B private skill",
        content: "B private instructions",
      })
    ).error,
    null,
  )
  const workspaceA = (await rpc(a.socket, "workspace.info")).result.path,
    workspaceB = (await rpc(b.socket, "workspace.info")).result.path
  assert.notEqual(workspaceA, workspaceB)
  assert.ok(workspaceA)
  assert.ok(workspaceB)
  assert.equal((await rpc(a.socket, "voice.stt.config.update", { serviceUrl: "http://127.0.0.1:45678" })).error, null)
  assert.notEqual((await rpc(b.socket, "voice.config.read")).result.stt.serviceUrl, "http://127.0.0.1:45678")
  const headers = (token?: string) => ({
    authorization: `Bearer ${config.token}`,
    "content-type": "text/plain",
    ...(token ? { "x-eden-core-token": token } : {}),
  })
  const url = () => `http://127.0.0.1:${server.port}/blobs`
  const uploaded = await fetch(url(), { method: "POST", headers: headers("account-a"), body: "A attachment" })
  assert.equal(uploaded.status, 200)
  const blob = (await uploaded.json()) as { id: string }
  const uploadedBackground = await fetch(url(), {
    method: "POST",
    headers: { ...headers("account-a"), "content-type": "image/png" },
    body: "synthetic image bytes",
  })
  assert.equal(uploadedBackground.status, 200)
  const backgroundBlob = (await uploadedBackground.json()) as { id: string }
  assert.equal((await fetch(`${url()}/${blob.id}`, { headers: headers() })).status, 401)
  assert.equal((await fetch(`${url()}/${blob.id}`, { headers: headers("account-b") })).status, 404)
  assert.equal((await fetch(`${url()}/${blob.id}`, { headers: headers("account-a") })).status, 200)
  assert.ok(
    (
      await rpc(b.socket, "turn.start", {
        sessionId: second,
        text: "read",
        attachments: [{ blobId: blob.id, mime: "text/plain" }],
      })
    ).error,
  )
  assert.equal((await rpc(a.socket, "ui.preferences.update", { autoScrollEnabled: false })).error, null)
  assert.ok((await rpc(a.socket, "ui.background.update", { opacity: 62, blur: 11, imageBlobId: blob.id })).error)
  assert.equal(
    (await rpc(a.socket, "ui.background.update", { opacity: 62, blur: 11, imageBlobId: backgroundBlob.id })).error,
    null,
  )
  assert.equal((await rpc(b.socket, "ui.preferences.get")).result.autoScrollEnabled, true)
  assert.deepEqual((await rpc(b.socket, "ui.background.get")).result, { opacity: 100, blur: 0, imageBlobId: null })
  assert.ok(
    (await rpc(b.socket, "ui.background.update", { opacity: 62, blur: 11, imageBlobId: backgroundBlob.id })).error,
  )
  for (const socket of sockets) socket.terminate()
  await server.close()
  server = await startServer(config)
  const restored = await connect("account-a")
  assert.deepEqual(
    (await rpc(restored.socket, "session.list")).result.map((s: any) => s.id),
    [first],
  )
  assert.equal((await rpc(restored.socket, "ui.preferences.get")).result.autoScrollEnabled, false)
  assert.deepEqual((await rpc(restored.socket, "ui.background.get")).result, {
    opacity: 62,
    blur: 11,
    imageBlobId: backgroundBlob.id,
  })
  assert.equal((await rpc(restored.socket, "permission.mode.get")).result.mode, "takeover")
  assert.equal((await rpc(restored.socket, "voice.config.read")).result.stt.serviceUrl, "http://127.0.0.1:45678")
  const restoredB = await connect("account-b")
  assert.equal((await rpc(restoredB.socket, "permission.mode.get")).result.mode, "restricted")
  assert.match((await rpc(restoredB.socket, "plugin.draft.read", { id: "account-tool" })).result.source, /value:'B'/)
  assert.deepEqual((await rpc(restoredB.socket, "plugin.version.list")).result, [])
})
