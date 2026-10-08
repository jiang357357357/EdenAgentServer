import assert from 'node:assert/strict'
import test from 'node:test'
import { Terminal } from '../../../tui/terminal.ts'
import type { KeyPress } from '../../../tui/terminal-input.ts'
import type { ScreenPanel } from '../../../tui/screen-state.ts'

interface InputState {
  keypress(text: string | undefined, key?: KeyPress): void
  input: string
  cursor: number
  history: string[]
  panelState?: ScreenPanel
  sidebarVisible: boolean
  closed: boolean
}

function editor() {
  const lines: string[] = []
  const terminal = new Terminal(line => lines.push(line))
  const state = terminal as unknown as InputState
  const key = (name: string, modifiers: KeyPress = {}, text?: string) => state.keypress(text, { name, ...modifiers })
  return { terminal, state, lines, key, type: (text: string) => state.keypress(text) }
}

test('editing treats emoji clusters and combining characters as a single character', () => {
  const { terminal, state, key, type } = editor()
  terminal.setDraft('中👨‍👩‍👧‍👦e\u0301')
  assert.equal(state.cursor, 3)
  key('left')
  key('backspace')
  assert.equal(state.input, '中e\u0301')
  assert.equal(state.cursor, 1)
  key('delete')
  type('文')
  assert.equal(state.input, '中文')
  key('a', { ctrl: true })
  type('前')
  key('e', { ctrl: true })
  type('后')
  assert.equal(state.input, '前中文后')
  key('u', { ctrl: true })
  assert.equal(state.input, '')
})

test('bracketed paste accumulates newlines without submitting or invoking commands', () => {
  const { state, lines, key, type } = editor()
  key('paste-start')
  type('/stop')
  key('return')
  type('第二行')
  assert.deepEqual(lines, [])
  key('paste-end')
  assert.equal(state.input, '/stop\n第二行')
  key('return')
  assert.deepEqual(lines, ['/stop\n第二行'])
})

test('password mode preserves spaces, suppresses global shortcuts and does not save history', () => {
  const { terminal, state, lines, key, type } = editor()
  terminal.setInputMode('password')
  type(' password ')
  key('n', { ctrl: true })
  key('1', { meta: true }, '1')
  key('return')
  assert.deepEqual(lines, [' password '])
  assert.deepEqual(state.history, [])
  type('discard')
  key('escape')
  assert.equal(state.input, '')
  assert.deepEqual(lines, [' password ', '/login-back'])
})

test('question input saves the draft, blocks navigation and lets Escape return to it', () => {
  const { terminal, state, lines, key, type } = editor()
  terminal.setDraft('未发送草稿')
  terminal.prompt('回答> ')
  type('答案')
  key('n', { ctrl: true })
  key('s', { ctrl: true })
  key('f1')
  key('escape')
  assert.deepEqual(lines, ['/back'])
  terminal.prompt('> ')
  assert.equal(state.input, '未发送草稿')
})

test('searchable menus filter pasted text and Enter dispatches the filtered selection', () => {
  const { terminal, state, lines, key, type } = editor()
  terminal.setDraft('消息草稿')
  terminal.showMenu('会话', [
    { label: '第一会话', command: '/use first' },
    { label: '第二会话', command: '/use second' },
  ], [], true)
  key('paste-start')
  type('第二')
  key('paste-end')
  assert.equal(state.panelState?.items?.length, 1)
  key('return')
  assert.deepEqual(lines, ['/use second'])
  assert.equal(state.panelState, undefined)
  assert.equal(state.input, '消息草稿')
})

test('numeric menu selection and Escape take precedence over the input editor', () => {
  const { terminal, state, lines, key, type } = editor()
  terminal.showMenu('审批', [
    { label: '允许', command: '/allow p1' },
    { label: '拒绝', command: '/deny p1' },
  ])
  type('2')
  assert.deepEqual(lines, ['/deny p1'])
  terminal.showMenu('再次确认', [{ label: '提交', command: '/always p1' }])
  key('escape')
  assert.equal(state.panelState, undefined)
  assert.equal(state.input, '')
  assert.deepEqual(lines, ['/deny p1'])
})

test('slash completion distinguishes commands with arguments from immediate actions', () => {
  const { state, lines, key, type } = editor()
  type('/ren')
  key('return')
  assert.equal(state.input, '/rename ')
  assert.deepEqual(lines, [])
  type('新名字')
  key('return')
  assert.deepEqual(lines, ['/rename 新名字'])
  type('/sess')
  key('tab')
  assert.equal(state.input, '/sessions')
  key('return')
  assert.deepEqual(lines, ['/rename 新名字', '/sessions'])
})

test('history restores an unsent draft and remains independent for each session', () => {
  const { terminal, state, key, type } = editor()
  terminal.setSession('a', 'A', false)
  type('已发消息')
  key('return')
  type('当前草稿')
  key('up')
  assert.equal(state.input, '已发消息')
  key('down')
  assert.equal(state.input, '当前草稿')
  terminal.setSession('b', 'B', false)
  assert.equal(state.input, '')
  assert.deepEqual(state.history, [])
  type('B 的草稿')
  terminal.setSession('a', 'A', false)
  assert.equal(state.input, '当前草稿')
  assert.deepEqual(state.history, ['已发消息'])
})

test('keyboard commands, multiline input and Ctrl+C keep their normal-mode behavior', () => {
  const { state, lines, key, type } = editor()
  key('p', { ctrl: true })
  key('s', { ctrl: true })
  key('n', { ctrl: true })
  key('x', { ctrl: true })
  key('3', { meta: true }, '3')
  key('f1')
  key('f1', { ctrl: true })
  key('b', { ctrl: true })
  assert.equal(state.sidebarVisible, true)
  assert.deepEqual(lines, ['/menu', '/sessions', '/new', '/stop', '/use 3', '/help', '/help'])
  type('第一行')
  key('return', { shift: true })
  type('第二行')
  key('j', { ctrl: true })
  type('第三行')
  key('return')
  assert.equal(lines.at(-1), '第一行\n第二行\n第三行')
  key('c', { ctrl: true })
  assert.equal(state.closed, true)
})
