import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiagnosticLogger, formatDiagnostic, logUsesColor, type DiagnosticRecord } from '../../../src/modules/logging/index.ts'

const record: DiagnosticRecord = { event: 'server.startup', level: 'info', origin: 'mon', pid: 7,
  time: new Date(2026, 9, 3, 9, 8, 7, 6).toISOString(), stage: 'account.services', account: 'account-123',
  payload: { privateUserText: 'never-print-this-payload' } }

test('console diagnostics use local time, readable stage names and selected fields only', () => {
  const line = formatDiagnostic(record)
  assert.match(line, /^\[09:08:07\.006\] \[INFO\] \[Agent\/伊甸园\]/)
  assert.match(line, /服务启动 · 初始化账号服务/)
  assert.match(line, /账号=account-123/)
  assert.doesNotMatch(line, /payload|never-print-this-payload/)
  assert.equal(line.split('\n').length, 2)
})

test('SQLite warnings display the Chinese message without dumping English detail or stacks', () => {
  const line = formatDiagnostic({ ...record, event: 'process.warning', level: 'warn', origin: 'local',
    warningName: 'ExperimentalWarning', message: '当前 Node.js 内置 SQLite 接口带有实验性标记',
    detail: 'original warning detail', stack: 'internal stack trace' })
  assert.match(line, /\[WARN\] \[Agent\/尘世\] Node.js 运行提示/)
  assert.match(line, /ExperimentalWarning/)
  assert.match(line, /SQLite 接口带有实验性标记/)
  assert.doesNotMatch(line, /original warning detail|internal stack trace/)
})

test('color is optional and NO_COLOR takes precedence over tty and FORCE_COLOR', () => {
  assert.equal(logUsesColor({}, false), false)
  assert.equal(logUsesColor({}, true), true)
  assert.equal(logUsesColor({ FORCE_COLOR: '1' }, false), true)
  assert.equal(logUsesColor({ FORCE_COLOR: '0' }, true), false)
  assert.equal(logUsesColor({ NO_COLOR: '', FORCE_COLOR: '1' }, true), false)
  assert.match(formatDiagnostic(record, true), /\x1b\[36m\[INFO\]\x1b\[0m/)
})

test('an unconfigured factory remains text-only by default and supports useful error summaries', () => {
  const output: string[] = []
  const logger = createDiagnosticLogger({ env: {}, tty: false, writeConsole: line => { output.push(line) } })
  logger.log({ event: 'plugin.failed', message: '插件执行失败', error: new Error('execution failed'), arbitrary: 'not-on-console', code: undefined }, 'error')
  assert.match(output[0]!, /\[ERROR\] \[Agent\].*插件执行失败；execution failed/)
  assert.doesNotMatch(output[0]!, /undefined/)
  assert.doesNotMatch(output[0]!, /not-on-console/)
  assert.throws(() => JSON.parse(output[0]!))
  logger.close()
})
