import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthFlow } from '../../../tui/auth-flow.ts'
import { Terminal } from '../../../tui/terminal.ts'

const config = { origin: 'local' as const, port: 1, tokenFile: '', coreUrl: 'http://127.0.0.1:1', authFile: '' }

test('connection failures preserve the account scope and current draft through retry', async () => {
  const terminal = new Terminal(() => {})
  let attempts = 0
  const resets: (boolean | undefined)[] = []
  const auth = new AuthFlow(config, terminal, async () => {
    attempts++
    if (attempts === 1) throw new Error('fixture disconnected')
  }, reset => { resets.push(reset) })
  await auth.bootstrap()
  assert.equal(auth.retryable, true)
  terminal.setDraft('正在编辑的草稿')
  await auth.retry()
  assert.equal(auth.authenticated, true)
  assert.deepEqual(resets, [false])
  assert.equal((terminal as unknown as { input: string }).input, '正在编辑的草稿')
})

test('a cancelled authentication attempt cannot mark a late connection result authenticated', async () => {
  const terminal = new Terminal(() => {})
  let connected: () => void = () => {}
  const entered = new Promise<void>(resolve => { connected = resolve })
  let finish: () => void = () => {}
  const auth = new AuthFlow(config, terminal, () => { connected(); return new Promise(resolve => { finish = resolve }) }, () => {})
  const pending = auth.bootstrap()
  await entered
  auth.cancel(); auth.disconnected('重连取消')
  finish(); await pending
  assert.equal(auth.authenticated, false)
  assert.equal(auth.retryable, true)
})
