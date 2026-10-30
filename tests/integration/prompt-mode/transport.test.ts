import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { websocketProtocol, tokenProtocolPrefix, promptModeConfigSchema } from '@eden/api'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { startServer } from '../../../src/bootstrap/container.ts'

function request(client: WebSocket, method: string, params: unknown): Promise<any> {
  const id = Math.random().toString()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('message', listener); reject(new Error(`RPC timeout: ${method}`)) }, 5000)
    const listener = (data: Buffer) => {
      const result = JSON.parse(data.toString())
      if (result.id !== id) return
      clearTimeout(timer); client.off('message', listener); resolve(result)
    }
    client.on('message', listener)
    client.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

test('running host exposes mode only after authenticated initialize and validates updates over WebSocket', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-prompt-mode-'))
  const config = loadConfig({ EDEN_AGENT_DATA_ROOT: path.join(root, 'data'), EDEN_AGENT_PORT: '0',
    EDEN_AGENT_TERMINAL_SETTINGS_PATH: path.join(root, 'terminal-settings.json') }, root)
  const server = await startServer(config)
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, [websocketProtocol, tokenProtocolPrefix + config.token])
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    assert.equal((await request(client, 'prompt.mode.get', {})).error.code, -32001)
    const initialized = await request(client, 'initialize', { protocolVersion: 2, runtimeOrigin: 'local', clientName: 'prompt-mode-test', clientVersion: '1', capabilities: [] })
    assert.equal(initialized.error, null)
    assert.ok(initialized.result.capabilities.includes('prompt.mode.get'))
    assert.ok(initialized.result.capabilities.includes('prompt.mode.update'))
    assert.deepEqual((await request(client, 'prompt.mode.get', {})).result, { enabled: false, updatedAt: 0 })
    const saved = await request(client, 'prompt.mode.update', { enabled: true, expectedUpdatedAt: 0 })
    assert.equal(saved.error, null)
    assert.equal(promptModeConfigSchema.parse(saved.result).enabled, true)
    assert.ok(!Object.hasOwn(saved.result, 'template'))
    const invalid = await request(client, 'prompt.mode.update', { enabled: true, template: '', expectedUpdatedAt: saved.result.updatedAt })
    assert.equal(invalid.error.code, -32602)
    assert.deepEqual((await request(client, 'prompt.mode.get', {})).result, saved.result)
  } finally {
    client.terminate(); await server.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('eden-prompt-mode-'))
    await rm(root, { recursive: true, force: true })
  }
})
