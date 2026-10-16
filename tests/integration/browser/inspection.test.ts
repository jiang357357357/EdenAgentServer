import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { BrowserService, browserTools } from '../../../src/modules/browser/index.ts'
import type { PermissionService } from '../../../src/modules/permissions/index.ts'
import { createIsolatedRuntime } from '@eden/runtime-pi'
import { recordedModel } from '@eden/runtime-pi/testing'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-browser-inspection-')), db = new EdenDatabase(':memory:', 'local')
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<title>渲染夹具</title><main id="app">初始</main><input type="password" value="must-not-capture"><script>setTimeout(()=>{document.querySelector("main").textContent="实际绘制完成";console.log("fixture-console");throw Error("fixture-page-error")},20)</script>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`
  const blobs = new BlobService(path.join(root, 'blobs'), new BlobRepository(db)), browser = new BrowserService(blobs)
  let denied = false, approvals = 0
  const permissions = { async request() { approvals++; if (denied) throw new Error('Permission denied') } } as unknown as PermissionService
  const tool = browserTools(browser, permissions, 'session', 'turn')[0]!
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await rm(root, { recursive: true, force: true }) })
  return { browser, blobs, tool, url, requests: () => requests, approvals: () => approvals, deny: () => { denied = true } }
}

test('real headless browser returns rendered DOM, console, page errors and a model image through isolated runtime', { timeout: 30000 }, async t => {
  const f = await fixture(t), model = await recordedModel([{ tool: 'browser_inspect', input: { url: f.url, waitMs: 150 } }, { text: '渲染完成' }])
  const runtime = createIsolatedRuntime({ sessionId: 'browser-fixture', systemPrompt: '测试网页', model: model.config, tools: [f.tool],
    callbacks: { async checkpoint() {}, async event() {}, async request() {} } })
  t.after(async () => { await runtime.dispose(); await model.close() })
  await runtime.prompt('检查页面'); await runtime.waitForIdle()
  assert.equal(f.approvals(), 1); assert.ok(f.requests() > 0)
  const messages = JSON.stringify(model.requests.at(-1)!.messages)
  assert.match(messages, /实际绘制完成/); assert.match(messages, /fixture-console/); assert.match(messages, /fixture-page-error/)
  assert.match(messages, /data:image\/png;base64/); assert.doesNotMatch(messages, /must-not-capture|sha256/)
})

test('browser denials and unsafe URLs never reach the fixture; cancellation closes the owned browser', { timeout: 30000 }, async t => {
  const f = await fixture(t), signal = new AbortController().signal
  for (const url of ['file:///C:/Windows/win.ini', 'http://user:secret@127.0.0.1/']) await assert.rejects(f.tool.execute({ url }, { callId: 'bad', signal }), /HTTP/)
  assert.equal(f.approvals(), 0)
  f.deny(); await assert.rejects(f.tool.execute({ url: f.url }, { callId: 'denied', signal }), /denied/)
  assert.equal(f.requests(), 0)
  const controller = new AbortController()
  const pending = f.browser.inspect({ url: f.url, screenshot: false, waitMs: 5000 }, controller.signal)
  const rejected = assert.rejects(pending, /abort|cancel/i)
  setTimeout(() => controller.abort(new Error('cancelled fixture')), 1000)
  await rejected
})

test('selecting a form input also hides its value from DOM inspection', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const result = await f.browser.inspect({ url: f.url, selector: 'input', screenshot: false, waitMs: 50 }, new AbortController().signal)
  assert.doesNotMatch(result.html, /must-not-capture|value=/)
})
