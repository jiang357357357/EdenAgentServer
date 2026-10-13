import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EdenDatabase } from '@eden/store'
import { terminalInfoSchema } from '@eden/api'
import { CommandService } from '../../../src/modules/commands/index.ts'
import { terminalToolContext } from '../../../src/model-prompts/terminal.ts'

test('terminal guidance describes persistent temporary files, shell failures and Node module boundaries', () => {
  const description = terminalToolContext({ kind: 'wsl', distribution: 'Ubuntu' })
  for (const text of ['pipefail', '"$TMPDIR"', 'tmpfs', '.cjs', '.mjs', '不依赖 WSL', '独立 shell', '不保证', '结果可能未知']) assert.ok(description.includes(text), text)
  assert.doesNotMatch(terminalToolContext({ kind: 'host' }), /跨调用临时文件|WSL 的后台/)
})
test('terminal contract accepts both older results and explicit detection failures', () => {
  const value = { platform: 'win32', hostShell: 'powershell.exe', hostAvailable: true, wslDistributions: [],
    deviceDefault: { kind: 'host' }, sessionOverride: null, effective: { kind: 'host' } }
  assert.ok(terminalInfoSchema.safeParse(value).success)
  assert.equal(terminalInfoSchema.parse({ ...value, wslDetectionError: '无法确认状态' }).wslDetectionError, '无法确认状态')
})
test('detection failure keeps the saved WSL choice visible, allows selecting host and prevents saving an unverified distro', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-terminal-detection-'))
  const settings = path.join(root, 'terminal-settings.json'), database = new EdenDatabase(':memory:', 'local')
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args[3] as (error: Error, stdout: Buffer, stderr: Buffer) => void
    queueMicrotask(() => callback(Object.assign(new Error('timeout'), { killed: true }), Buffer.alloc(0), Buffer.alloc(0)))
    return {}
  })
  syncBuiltinESMExports()
  try {
    await writeFile(settings, JSON.stringify({ kind: 'wsl', distribution: 'Ubuntu' }))
    const service = new CommandService(database, [], undefined, { deviceSettingsPath: settings })
    const info = terminalInfoSchema.parse(await service.terminalInfo())
    assert.deepEqual(info.effective, { kind: 'wsl', distribution: 'Ubuntu' })
    assert.match(info.wslDetectionError!, /检测超时/)
    assert.deepEqual(info.wslDistributions, [])
    const saved = await service.terminalSet({ scope: 'device', target: { kind: 'host' } })
    assert.equal(saved.effective.kind, 'host')
    assert.match(saved.wslDetectionError!, /检测超时/)
    await assert.rejects(service.terminalSet({ scope: 'device', target: { kind: 'wsl', distribution: 'Ubuntu' } }), /检测超时/)
    assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { kind: 'host' })
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); database.close()
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected terminal fixture cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})
