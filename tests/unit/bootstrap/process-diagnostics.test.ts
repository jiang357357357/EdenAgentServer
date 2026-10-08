import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installProcessDiagnostics } from '../../../src/bootstrap/process-diagnostics.ts'
import { configureLogging, loggingFile } from '../../../src/modules/logging/index.ts'

test('process diagnostics retain warning observers, preserve unknown warnings and restore the native printer once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eden-process-diagnostics-'))
  const options = { origin: 'local' as const, dataRoot: root, env: {} }
  const logging = configureLogging(options)
  const original = process.listeners('warning')
  const observed: Error[] = []
  const observer = (warning: Error) => { observed.push(warning) }
  process.on('warning', observer)
  const removeDiagnostics = installProcessDiagnostics()
  try {
    const sqlite = Object.assign(new Error('SQLite is an experimental feature and might change at any time'), { name: 'ExperimentalWarning' })
    const unknown = Object.assign(new Error('Library changed: api_key="do-not-log"\nunsafe'), { name: 'DeprecationWarning', code: 'TEST_WARNING' })
    process.emit('warning', sqlite)
    process.emit('warning', unknown)
    assert.deepEqual(observed, [sqlite, unknown])
    const source = readFileSync(loggingFile(options), 'utf8')
    assert.doesNotMatch(source, /do-not-log/)
    const records = source.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(records.length, 2)
    assert.equal(records[0].event, 'process.warning')
    assert.equal(records[0].warningName, 'ExperimentalWarning')
    assert.match(records[0].message, /SQLite.*实验性/)
    assert.equal(records[1].warningName, 'DeprecationWarning')
    assert.equal(records[1].code, 'TEST_WARNING')
    assert.match(records[1].message, /Library changed/)
    assert.equal(records[1].level, 'warn')
    removeDiagnostics()
    removeDiagnostics()
    assert.equal(process.listeners('warning').length, original.length + 1)
    for (const listener of [...original, observer]) assert.ok(process.listeners('warning').includes(listener))
  } finally {
    removeDiagnostics()
    process.removeListener('warning', observer)
    logging.close()
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('eden-process-diagnostics-'))
    rmSync(root, { recursive: true, force: true })
  }
})
