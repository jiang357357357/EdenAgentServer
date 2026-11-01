import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openOsRuntime } from '../../../src/bootstrap/os-runtime.ts'
import { osFixture } from '../../helpers/os-config.ts'
import { McpClient, McpHttpChannel } from '@eden/integrations'

test('same-process MCP retains all 14 tools, semantic memo data and the real native client contract', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'eden-os-'))
  const unavailable = async () => { throw new Error('unbound') }
  const runtime = await openOsRuntime(osFixture(root), { ready: () => false, control: unavailable, run: unavailable, status: unavailable, admitReminder: unavailable, reminderDelivery: unavailable })
  let channel: McpHttpChannel | undefined
  try {
    const endpoint = `http://127.0.0.1:${runtime.port}`
    const health = await (await fetch(`${endpoint}/health`)).json() as { pid: number; owner: string }
    assert.equal(health.pid, process.pid); assert.equal(health.owner, 'eden-agent-ts')
    channel = new McpHttpChannel(`${endpoint}/mcp`, () => {})
    const client = new McpClient(channel)
    const controller = new AbortController()
    await client.initialize(controller.signal)
    const tools = await client.tools(controller.signal)
    assert.equal(tools.length, 14)
    const created = await client.call('memo_create', { title: '保留提醒', description: '中文内容', due_at: '2030-01-02T03:04:05+08:00' }, controller.signal)
    const body = created as unknown as { structuredContent: { success: boolean; data: { id: number } } }
    assert.equal(body.structuredContent.success, true)
    const id = body.structuredContent.data.id
    const completed = await client.call('memo_complete', { task_id: id }, controller.signal)
    assert.match(JSON.stringify(completed), /completed/)
    const rejected = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    assert.equal(rejected.status, 403)
    const bad = await client.call('recall_search', { collection_name: '../private', query_text: 'x' }, controller.signal)
    assert.match(JSON.stringify(bad), /false/)
  } finally { await channel?.dispose(); await runtime.close(); rmSync(root, { recursive: true, force: true }) }
})
