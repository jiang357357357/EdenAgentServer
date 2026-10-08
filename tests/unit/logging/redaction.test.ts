import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDiagnosticLogger, redactRecord, safeLogText } from '../../../src/modules/logging/index.ts'

test('recursive redaction covers credential keys, error causes and credential-bearing strings', () => {
  const cause = new Error('request https://username:pass-value@example.test/?token=query-secret&api_key=key-secret failed; Bearer bearer-secret')
  const input = { event: 'request.failed', token: 'root-token', nested: { coreToken: 'core-token', password: 'pw-value',
    headers: { Authorization: 'header-secret', 'set-cookie': 'cookie-secret' }, api_key: 'nested-key',
    usage: { totalTokens: 42 } }, error: new Error('password=message-secret', { cause }) }
  const result = redactRecord(input)
  const serialized = JSON.stringify(result)
  for (const value of ['root-token', 'core-token', 'pw-value', 'header-secret', 'cookie-secret', 'nested-key',
    'username', 'pass-value', 'query-secret', 'key-secret', 'bearer-secret', 'message-secret']) assert.ok(!serialized.includes(value), value)
  assert.ok(serialized.includes('[已脱敏]'))
  assert.ok(serialized.includes('"totalTokens":42'))
  assert.equal(input.token, 'root-token', 'logging never mutates business inputs')
})

test('quoted JSON keys, encoded query names and quoted values are redacted inside error text', () => {
  const result = safeLogText('failed {"api_key":"json-secret","nested":{"client_secret":"nested secret"}} '
    + "password='secret with spaces' https://example.test/?%74oken=encoded-secret&client_secret=client-value&safe=visible")
  for (const secret of ['json-secret', 'nested secret', 'secret with spaces', 'encoded-secret', 'client-value']) assert.ok(!result.includes(secret), secret)
  assert.ok(result.includes('safe=visible'))
  assert.ok(result.includes('"api_key":"[已脱敏]"'))
  assert.equal(safeLogText(`{"password":"${'x'.repeat(20000)}"}`), '{"password":"[已脱敏]"')
  assert.equal(safeLogText(`-----BEGIN PRIVATE KEY-----${'x'.repeat(20000)}-----END PRIVATE KEY-----`), '[已脱敏]')
})

test('undefined fields stay absent instead of becoming misleading text', () => {
  const result = redactRecord({ event: 'process.warning', code: undefined })
  assert.equal(result.code, undefined)
  assert.equal(JSON.stringify(result), '{"event":"process.warning"}')
})

test('control characters, bidi overrides and long values cannot inject console lines', () => {
  const text = safeLogText('safe\x1b]0;changed-title\x07\r\nFORGED\u202evalue\u2066')
  assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/)
  assert.equal(safeLogText('x'.repeat(9000)).length, 8000)
  const output: string[] = []
  const logger = createDiagnosticLogger({ env: {}, writeConsole: line => { output.push(line) } })
  logger.log({ event: 'test\nFORGED', message: 'message\r\nFORGED\x1b[31m', path: 'x\nFORGED' })
  assert.equal(output[0]!.split('\n').length, 2)
  assert.doesNotMatch(output[0]!, /\x1b/)
  logger.close()
})

test('cycles, bigint and failing diagnostic getters cannot fail application calls', () => {
  const cyclic: Record<string, unknown> = { count: 10n }
  cyclic.self = cyclic
  assert.match(JSON.stringify(redactRecord(cyclic)), /循环引用/)
  const output: string[] = []
  const logger = createDiagnosticLogger({ env: {}, writeConsole: line => { output.push(line) } })
  assert.doesNotThrow(() => logger.log({ event: 'failure', get invalid() { throw new Error('getter-secret') } }))
  assert.match(output[0]!, /无法序列化/)
  assert.doesNotMatch(output[0]!, /getter-secret/)
  logger.close()
})

test('a failing console writer cannot replace a business result', () => {
  const logger = createDiagnosticLogger({ env: {}, writeConsole: () => { throw new Error('closed pipe') } })
  assert.doesNotThrow(() => logger.log({ event: 'self_awake.request_failed', message: '请求已拒绝' }, 'warn'))
  logger.close()
})
