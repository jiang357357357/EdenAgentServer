import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDiagnosticLogger, loggingFile } from '../../../src/modules/logging/index.ts'

test('JSONL keeps original event fields and redacted metadata while console stays text', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-log-record-'))
  const filename = path.join(directory, 'log.jsonl'), output: string[] = []
  const logger = createDiagnosticLogger({ filename, origin: 'mon', env: {},
    now: () => new Date('2026-10-03T01:02:03.000Z'), writeConsole: line => { output.push(line) } })
  try {
    logger.log({ event: 'server.listening', port: 40100, extra: { preserved: true }, accessToken: 'secret-value', time: 'forged', pid: 1 })
    logger.close()
    const record = JSON.parse(readFileSync(filename, 'utf8'))
    assert.equal(record.event, 'server.listening')
    assert.equal(record.level, 'info')
    assert.equal(record.pid, process.pid)
    assert.equal(record.origin, 'mon')
    assert.equal(record.time, '2026-10-03T01:02:03.000Z')
    assert.deepEqual(record.extra, { preserved: true })
    assert.equal(record.accessToken, '[已脱敏]')
    assert.match(output[0]!, /\[INFO\].*服务已就绪.*端口=40100/)
    assert.doesNotMatch(output[0]!, /preserved|secret-value/)
  } finally { logger.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('explicit JSON console mode preserves severity streams and still saves JSONL', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-log-json-'))
  const filename = path.join(directory, 'log.jsonl')
  const output: { line: string; stream: string }[] = []
  const logger = createDiagnosticLogger({ filename, origin: 'local', env: { EDEN_AGENT_LOG_FORMAT: 'json', FORCE_COLOR: '1' },
    writeConsole: (line, stream) => { output.push({ line, stream }) } })
  try {
    logger.log({ event: 'server.account.failure', message: 'token=private-value' }, 'error')
    assert.equal(output[0]!.stream, 'stderr')
    assert.equal(JSON.parse(output[0]!.line).level, 'error')
    assert.equal(output[0]!.line, readFileSync(filename, 'utf8'))
    assert.doesNotMatch(output[0]!.line, /private-value|\x1b/)
    logger.log({ event: 'server.listening', origin: 'mon' }, 'info')
    assert.equal(output[1]!.stream, 'stdout')
    assert.equal(JSON.parse(output[1]!.line).origin, 'mon', 'explicit record origin survives an embedding process default')
  } finally { logger.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('rotation retains exactly three backups with complete parseable records', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-log-rotation-'))
  const filename = path.join(directory, 'log.jsonl')
  const logger = createDiagnosticLogger({ filename, maxBytes: 1, backups: 3, env: {}, writeConsole: () => {} })
  try {
    for (let sequence = 1; sequence <= 6; sequence++) logger.log({ event: 'test.rotation', sequence })
    logger.close()
    assert.deepEqual(readdirSync(directory).sort(), ['log.jsonl', 'log.jsonl.1', 'log.jsonl.2', 'log.jsonl.3'])
    for (const [suffix, sequence] of [['', 6], ['.1', 5], ['.2', 4], ['.3', 3]] as const) {
      assert.equal(JSON.parse(readFileSync(filename + suffix, 'utf8')).sequence, sequence)
    }
  } finally { logger.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('log file failures warn once without failing business calls or console output', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'eden-log-failure-'))
  const blocker = path.join(directory, 'not-a-directory'), output: string[] = []
  writeFileSync(blocker, 'occupied')
  const logger = createDiagnosticLogger({ filename: path.join(blocker, 'log.jsonl'), env: {},
    writeConsole: line => { output.push(line) } })
  try {
    assert.doesNotThrow(() => { logger.log({ event: 'server.listening' }); logger.log({ event: 'server.shutdown' }) })
    assert.equal(output.filter(line => line.includes('日志文件写入失败')).length, 1)
    assert.ok(output.some(line => line.includes('服务已就绪')))
    assert.ok(output.some(line => line.includes('服务正在关闭')))
  } finally { logger.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('log directory precedence and filenames isolate realm processes', () => {
  const dataRoot = path.join(tmpdir(), 'unused-data-root')
  const basename = `agent-mon-${process.pid}.jsonl`
  assert.equal(loggingFile({ origin: 'mon', dataRoot, env: {} }), path.join(dataRoot, 'logs', basename))
  assert.equal(loggingFile({ origin: 'mon', dataRoot, env: { MON_LOG_START_DIR: 'start' } }), path.join('start', 'Text', 'MonAgent', basename))
  assert.equal(loggingFile({ origin: 'mon', dataRoot, env: { MON_LOG_START_DIR: 'start', EDEN_AGENT_LOG_DIR: 'explicit' } }), path.join('explicit', basename))
  assert.notEqual(loggingFile({ origin: 'mon', dataRoot, env: {} }), loggingFile({ origin: 'local', dataRoot, env: {} }))
})
