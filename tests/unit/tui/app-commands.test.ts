import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../../../tui/app.ts'
import type { Terminal } from '../../../tui/terminal.ts'
import type { ScreenEntry, ScreenPanel } from '../../../tui/screen-state.ts'

type Request = { method: string; params: Record<string, unknown> }
type Session = { id: string; title: string; status: string; purpose: string; sourceChannel: string; executionStatus: string; participants: unknown[] }
interface AppAccess {
  handle(line: string): Promise<void>
  connected: boolean
  queue: Promise<void>
  current: Session | undefined
  sessions: Session[]
  terminal: Terminal
  answering: unknown
  auth: { authenticated: boolean; input(line: string): Promise<boolean>; logout(): Promise<void>; retry(): Promise<void>; accountLines(): string[] }
  models: { ensure(id: string): Promise<boolean>; refresh(): Promise<void>; showMenu(id?: string, refresh?: boolean): Promise<void>; preview(value: string): void; select(value: string): Promise<void> }
  rpc: { request(method: string, params: Record<string, unknown>): Promise<unknown> }
}

function harness() {
  const instance = new TuiApp({ origin: 'local', port: 1, tokenFile: '', coreUrl: 'http://127.0.0.1:1', authFile: '' }, 'test')
  const app = instance as unknown as AppAccess
  const session: Session = { id: 'session-a', title: 'A', status: 'active', purpose: 'user_chat', sourceChannel: 'app', executionStatus: 'idle', participants: [] }
  const calls: Request[] = []
  const controls: string[] = []
  const responses: Record<string, unknown> = {
    'session.list': [session], 'session.read': session, 'session.create': session,
    'message.list': { items: [], hasMore: false }, 'event.list': { items: [], hasMore: false },
    'session.timing.read': { turn: null, seq: '0', observedAt: 0 }, 'operation.list': [],
    'workspace.info': { path: 'E:/fixture', status: 'ready' },
    'permission.list': [], 'question.list': [],
    'turn.start': { state: 'accepted' }, 'turn.steer': { state: 'accepted' },
    'turn.follow_up': { state: 'queued' }, 'turn.cancel': { cancellationRequested: true },
  }
  app.auth = { authenticated: true, input: async () => false,
    logout: async () => { controls.push('logout') }, retry: async () => { controls.push('retry') }, accountLines: () => ['测试账号'] }
  app.models = { ensure: async () => true, refresh: async () => {},
    showMenu: async id => { controls.push(`models:${id}`) }, preview: value => { controls.push(`preview:${value}`) },
    select: async value => { controls.push(`select:${value}`) } }
  app.rpc = { request: async (method, params) => { calls.push({ method, params }); return responses[method] } }
  app.connected = true
  app.current = session
  app.sessions = [session]
  const view = app.terminal as unknown as { panelState?: ScreenPanel; input: string; entries: ScreenEntry[]; closed: boolean }
  return { app, calls, controls, responses, session, view }
}

test('quit is handled before authentication consumes input', async () => {
  const { app, view } = harness()
  app.auth.input = async () => { throw new Error('must not reach auth') }
  await app.handle('/quit')
  assert.equal(view.closed, true)
})

test('authentication consumes text and commands before normal command dispatch', async () => {
  const { app, calls, controls } = harness()
  const inputs: string[] = []
  app.auth.input = async line => { inputs.push(line); return true }
  await app.handle('/login')
  await app.handle('password')
  assert.deepEqual(inputs, ['/login', 'password'])
  assert.deepEqual(controls, [])
  assert.deepEqual(calls, [])
})

test('account recovery commands remain available when disconnected', async () => {
  const { app, controls, view, calls } = harness()
  app.connected = false
  app.auth.authenticated = false
  for (const command of ['/login', '/logout', '/retry', '/account', '']) await app.handle(command)
  assert.deepEqual(controls, ['logout', 'logout', 'retry'])
  assert.equal(view.panelState?.title, 'Core 账号')
  assert.deepEqual(view.panelState?.lines, ['测试账号'])
  await assert.rejects(app.handle('/help'), /请先在首页登录/)
  await assert.rejects(app.handle('消息'), /请先在首页登录/)
  assert.deepEqual(calls, [])
})

test('message submission preserves escaped slash text and supplies a fresh idempotency key', async () => {
  const { app, calls } = harness()
  await app.handle('//help')
  await app.handle('下一条')
  assert.deepEqual(calls.map(call => [call.method, call.params.text]), [['turn.start', '/help'], ['turn.start', '下一条']])
  assert.equal(calls[0]?.params.sessionId, 'session-a')
  assert.deepEqual(calls[0]?.params.attachments, [])
  assert.match(String(calls[0]?.params.idempotencyKey), /^[0-9a-f-]{36}$/)
  assert.notEqual(calls[0]?.params.idempotencyKey, calls[1]?.params.idempotencyKey)
})

test('missing model or model lookup failure restores the draft and never starts a turn', async () => {
  const { app, calls, view } = harness()
  app.models.ensure = async () => false
  await app.handle('保留草稿')
  assert.equal(view.input, '保留草稿')
  assert.deepEqual(calls, [])
  view.input = ''
  app.models.ensure = async () => { throw new Error('model unavailable') }
  await assert.rejects(app.handle('//escaped'), /model unavailable/)
  assert.equal(view.input, '/escaped')
  assert.deepEqual(calls, [])
})

test('a rejected turn start is recovered by the actual editor submission path', async () => {
  const { app, view, calls } = harness()
  app.terminal.setSession('session-a', 'A', false)
  app.rpc.request = async (method, params) => { calls.push({ method, params }); throw new Error('quota exceeded') }
  const editor = app.terminal as unknown as { keypress(text?: string, key?: { name: string }): void }
  editor.keypress('完整消息'); editor.keypress(undefined, { name: 'return' })
  await app.queue
  assert.equal(view.input, '完整消息')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'turn.start')
  assert.ok(view.entries.some(entry => entry.text === 'quota exceeded'))
})

test('sending from home creates and selects an app chat before starting a turn', async () => {
  const { app, calls } = harness()
  app.current = undefined
  await app.handle('首页消息')
  assert.equal(calls[0]?.method, 'session.create')
  assert.deepEqual(calls[0]?.params, { title: '新会话', participants: [] })
  assert.equal(calls.at(-1)?.method, 'turn.start')
  assert.equal(calls.at(-1)?.params.sessionId, 'session-a')
})

test('model and turn commands dispatch their trimmed arguments to the intended actions', async () => {
  const { app, calls, controls } = harness()
  await app.handle('/models')
  await app.handle('/model-preview   choice-a  ')
  await app.handle('/model-confirm choice-b')
  await app.handle('/steer   调整方向  ')
  await app.handle('/followup  继续  ')
  await app.handle('/stop')
  assert.deepEqual(controls, ['models:session-a', 'preview:choice-a', 'select:choice-b'])
  assert.deepEqual(calls, [
    { method: 'turn.steer', params: { sessionId: 'session-a', text: '调整方向' } },
    { method: 'turn.follow_up', params: { sessionId: 'session-a', text: '继续' } },
    { method: 'turn.cancel', params: { sessionId: 'session-a' } },
  ])
  for (const command of ['/steer', '/followup', '/rename', '/permission', '/answer']) {
    await assert.rejects(app.handle(command), /用法/)
  }
  await assert.rejects(app.handle('/unknown'), /未知命令/)
})

test('session selection resolves list numbers and rejects invalid or non-app sessions', async () => {
  const { app, calls, responses, session } = harness()
  await app.handle('/use 1')
  assert.deepEqual(calls[0], { method: 'session.read', params: { sessionId: 'session-a' } })
  await assert.rejects(app.handle('/use 9'), /会话编号无效/)
  await assert.rejects(app.handle('/use'), /用法/)
  responses['session.read'] = { ...session, sourceChannel: 'qq' }
  await assert.rejects(app.handle('/use qq-session'), /只能打开未关闭的应用聊天会话/)
})

test('permission decisions resolve the selected pending request with the correct scope', async () => {
  for (const [command, decision] of [['/allow', 'once'], ['/always', 'always'], ['/deny', 'deny']]) {
    const { app, calls, responses } = harness()
    responses['permission.list'] = [
      { id: 'resolved', state: 'resolved' },
      { id: 'pending-id', state: 'pending', capability: 'write', resource: '/tmp/file' },
    ]
    await app.handle(`${command} 1`)
    assert.deepEqual(calls.find(call => call.method === 'permission.resolve'),
      { method: 'permission.resolve', params: { requestId: 'pending-id', decision } })
  }
})

test('always-allow first presents a confirmation menu without resolving the request', async () => {
  const { app, calls, responses, view } = harness()
  responses['permission.list'] = [{ id: 'pending-id', state: 'pending', capability: 'write', resource: '/tmp/file' }]
  await app.handle('/confirm-always pending')
  assert.equal(view.panelState?.title, '确认总是允许')
  assert.deepEqual(view.panelState?.items?.map(item => item.command), ['/permission pending-id', '/always pending-id'])
  assert.equal(calls.some(call => call.method === 'permission.resolve'), false)
})

test('question answers take precedence over commands and Escape restores the saved draft', async () => {
  const { app, calls, responses, view } = harness()
  responses['question.list'] = [{ id: 'question-a', state: 'pending', questions: [
    { header: '选项', question: '选择一个', custom: true, multiple: false, options: [{ label: 'A', description: '' }] },
  ] }]
  app.terminal.setDraft('原草稿')
  await app.handle('/answer 1')
  await app.handle('/back')
  assert.equal(app.answering, undefined)
  assert.equal(view.input, '原草稿')
  await app.handle('/answer 1')
  await app.handle('/help')
  assert.deepEqual(calls.find(call => call.method === 'question.resolve'),
    { method: 'question.resolve', params: { requestId: 'question-a', answers: [['/help']] } })
  assert.equal(view.input, '原草稿')
})
