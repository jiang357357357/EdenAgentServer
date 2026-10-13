import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { CommandService } from '../src/modules/commands/command-service.ts'

test('fresh and persisted sandbox configurations both resolve to host execution after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-command-policy-'))
  const terminalOptions = { deviceSettingsPath: path.join(root, 'terminal-settings.json') }
  const database = new EdenDatabase(':memory:', 'local')
  try {
    const service = new CommandService(database, [], undefined, terminalOptions)
    assert.equal((await service.info()).mode, 'host')
    database.connection.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (?, ?, ?)').run('command.execution', JSON.stringify({ mode: 'sandbox', networkAccess: false, writableRoots: ['/missing'] }), Date.now())
    const restored = new CommandService(database, [], undefined, terminalOptions)
    assert.deepEqual(restored.snapshot().config, { mode: 'host', networkAccess: true, writableRoots: [] })
    assert.equal((await restored.info()).sandboxAvailable, false)
    await assert.rejects(restored.set({ mode: 'sandbox', networkAccess: false, writableRoots: [], confirmHostExecution: false }), /开发者审阅/)
    assert.equal((await restored.set({ mode: 'host', networkAccess: true, writableRoots: [], confirmHostExecution: false })).mode, 'host')
  } finally {
    database.close()
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected command fixture cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

test('host terminal writes outside cwd and stale approved configurations are still rejected', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-host-command-'))
  try {
    const service = new CommandService(database, [], undefined, { deviceSettingsPath: path.join(root, 'terminal-settings.json') })
    const snapshot = service.snapshot(), filename = path.join(root, 'outside.txt')
    const command = process.platform === 'win32'
      ? `Set-Content -LiteralPath '${filename.replaceAll("'", "''")}' -Value 'host-ok' -NoNewline`
      : `printf host-ok > '${filename.replaceAll("'", "'\\''")}'`
    const result = await service.execute(snapshot, os.tmpdir(), command, new AbortController().signal)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(await readFile(filename, 'utf8'), 'host-ok')
    await service.set({ mode: 'host', networkAccess: true, writableRoots: [], confirmHostExecution: false })
    await assert.rejects(service.execute(snapshot, root, command, new AbortController().signal), /changed after approval/)
  } finally { database.close(); await rm(root, { recursive: true, force: true }) }
})

test('terminal works without a workspace and a later selection invalidates its pending directory', async () => {
  const { WorkspaceService, workspaceTools } = await import('../src/modules/workspace/index.ts')
  const { SessionRepository } = await import('../src/modules/sessions/index.ts')
  const { PermissionService } = await import('../src/modules/permissions/index.ts')
  const database = new EdenDatabase(':memory:', 'local')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eden-command-default-'))
  try {
    const sessions = new SessionRepository(database, 'local'), session = sessions.create('No workspace')
    const permissions = new PermissionService(database, sessions.events)
    const workspace = new WorkspaceService(database, [directory])
    const commands = new CommandService(database, [], undefined, { deviceSettingsPath: path.join(directory, 'terminal-settings.json') })
    const command = workspaceTools(workspace, permissions, session.id, session.id, commands).find(tool => tool.name === 'exec_command')!
    const context = { callId: 'first', signal: new AbortController().signal }
    const pending = command.execute({ command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' }, context)
    permissions.resolve(permissions.list().find(item => item.state === 'pending')!.id, true)
    const result = await pending as { exitCode: number; stdout: string }
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), workspace.commandRoot())
    assert.equal(workspace.info().path, '')
    const stale = command.execute({ command: 'echo unused' }, { ...context, callId: 'second' })
    const rejected = assert.rejects(stale, /Workspace changed/)
    workspace.switch(directory)
    permissions.resolve(permissions.list().find(item => item.state === 'pending')!.id, true)
    await rejected
  } finally { database.close(); await rm(directory, { recursive: true, force: true }) }
})
