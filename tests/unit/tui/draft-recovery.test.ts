import assert from 'node:assert/strict'
import test from 'node:test'
import { Terminal } from '../../../tui/terminal.ts'
import type { InputSubmission } from '../../../tui/input-drafts.ts'
import type { KeyPress } from '../../../tui/terminal-input.ts'

function editor() {
  const submissions: InputSubmission[] = []
  const terminal = new Terminal((_line, submission) => { if (submission) submissions.push(submission) })
  const state = terminal as unknown as { input: string; keypress(text?: string, key?: KeyPress): void }
  const type = (text: string) => state.keypress(text)
  const enter = () => state.keypress(undefined, { name: 'return' })
  const clear = () => state.keypress(undefined, { name: 'u', ctrl: true })
  terminal.setSession('a', 'A', false)
  return { terminal, state, submissions, type, enter, clear }
}

test('a confirmed failure restores a multiline Unicode message without another submission', () => {
  const { terminal, state, submissions, type, enter } = editor()
  type('中文👨‍👩‍👧‍👦\n第二行'); enter()
  assert.equal(state.input, '')
  terminal.recoverSubmission(submissions[0]!, true)
  assert.equal(state.input, '中文👨‍👩‍👧‍👦\n第二行')
  assert.equal(submissions.length, 1)
})

test('a late failure cannot overwrite newer editing, even when the new draft was cleared', () => {
  const { terminal, state, submissions, type, enter, clear } = editor()
  type('旧消息'); enter(); type('新的草稿')
  terminal.recoverSubmission(submissions[0]!, true)
  assert.equal(state.input, '新的草稿')
  assert.throws(() => terminal.restoreDraft(), /当前已有草稿/)
  clear(); terminal.restoreDraft()
  assert.equal(state.input, '旧消息')
  clear(); type('第二条'); enter(); type('又编辑过'); clear()
  terminal.recoverSubmission(submissions[1]!, true)
  assert.equal(state.input, '')
  terminal.restoreDraft()
  assert.equal(state.input, '第二条')
})

test('uncertain delivery requires manual recovery and failed slash commands do not replace it', () => {
  const { terminal, state, submissions, type, enter } = editor()
  type('可能已接受'); enter()
  terminal.recoverSubmission(submissions[0]!, false)
  assert.equal(state.input, '')
  type('/restore'); enter()
  assert.equal(submissions.length, 1)
  terminal.restoreDraft()
  assert.equal(state.input, '可能已接受')
})

test('disconnect and reconnect preserve editing; session drafts stay separate', () => {
  const { terminal, state, type } = editor()
  type('A 的草稿')
  terminal.setConnected(false); terminal.setInputMode('normal'); terminal.setConnected(true)
  assert.equal(state.input, 'A 的草稿')
  terminal.setSession('b', 'B', false); type('B 的草稿')
  terminal.setSession('a', 'A', false)
  assert.equal(state.input, 'A 的草稿')
  terminal.home(); type('首页草稿'); terminal.setSession('b', 'B', false)
  assert.equal(state.input, 'B 的草稿')
  terminal.home()
  assert.equal(state.input, '首页草稿')
})

test('late failures are scoped to the original session and discarded after account reset', () => {
  const { terminal, state, submissions, type, enter } = editor()
  type('A 的消息'); enter(); terminal.setSession('b', 'B', false)
  terminal.recoverSubmission(submissions[0]!, true)
  assert.equal(state.input, '')
  assert.throws(() => terminal.restoreDraft(), /没有待恢复/)
  terminal.setSession('a', 'A', false); terminal.restoreDraft()
  assert.equal(state.input, 'A 的消息')
  enter(); terminal.clearAccount(); terminal.setSession('a', 'A', false)
  terminal.recoverSubmission(submissions[1]!, true)
  assert.equal(state.input, '')
  assert.throws(() => terminal.restoreDraft(), /没有待恢复/)
})

test('passwords and question answers never create recovery snapshots', () => {
  const { terminal, submissions, type, enter } = editor()
  terminal.setInputMode('password'); type('secret'); enter()
  terminal.setInputMode('normal'); terminal.prompt('回答> '); type('答案'); enter()
  assert.equal(submissions.length, 0)
})
