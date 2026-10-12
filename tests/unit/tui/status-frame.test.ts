import assert from 'node:assert/strict'
import test from 'node:test'
import { renderFrame } from '../../../tui/terminal-frame.ts'
import { cells } from '../../../tui/screen-text.ts'
import { activityLine, participantLabel } from '../../../tui/status-view.ts'
import type { ScreenState } from '../../../tui/screen-state.ts'

const state: ScreenState = { width: 120, height: 24, origin: 'mon', connected: true, busy: true, title: '会话',
  sessionId: 'session', sessions: [], entries: [], scroll: 0, older: false, permissions: 0, questions: 0,
  input: '中文👨‍👩‍👧‍👦', inputCursor: 3, inputLabel: '消息>', sidebarVisible: false, modelLabel: 'provider/model',
  agentLabel: '阿罗娜', location: 'E:/服务端工作区', turnPhase: '执行工具', turnElapsedMs: 65_000, contextTokens: 1234 }

test('the frame shows world, agent, model, server workspace and active turn duration together', () => {
  const frame = renderFrame(state, [{ text: '消息内容', kind: 'normal' }], false)
  const text = frame.lines.join('\n')
  for (const value of ['伊甸园', '阿罗娜', 'provider/model', 'E:/服务端工作区', '执行工具', '本轮 01:05', '1,234 tokens']) assert.ok(text.includes(value), value)
})

test('frame rows and cursor remain inside narrow, short and wide terminal dimensions', () => {
  for (const [width, height] of [[20, 8], [30, 10], [80, 24], [120, 40]]) {
    for (const panel of [undefined, { title: '审批', lines: ['危险命令'.repeat(30)], selected: 0 }]) {
      const frame = renderFrame({ ...state, width: width!, height: height!, sidebarVisible: true, ...(panel ? { panel } : {}) }, [], false)
      assert.ok(frame.lines.length <= height!)
      for (const line of frame.lines) assert.ok(cells(line) <= width!, `${width}x${height}: ${line}`)
      assert.ok(frame.cursorRow >= 1 && frame.cursorRow <= height!)
      assert.ok(frame.cursorColumn >= 1 && frame.cursorColumn <= width!)
    }
  }
})

test('pending approvals and reconnect state take precedence without losing the turn clock', () => {
  assert.match(activityLine({ ...state, permissions: 1 }, 96), /等待审批 1 · 本轮 01:05/)
  assert.match(activityLine({ ...state, connected: false, authStage: 'connecting' }, 96), /正在重连 · 本轮 01:05/)
})

test('identity uses session participants and falls back safely for local or malformed metadata', () => {
  assert.equal(participantLabel([{ assistantName: '阿罗娜' }, { characterName: '普拉娜' }]), '阿罗娜、普拉娜')
  assert.equal(participantLabel([null, 'invalid', {}]), '智能体')
})
