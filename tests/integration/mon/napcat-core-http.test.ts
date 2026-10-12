import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { MonConnectionRepository } from '../../../src/modules/mon/connection-repository.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'

const core = path.resolve('../Core')
const python = path.join(core, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const script = path.join(core, 'Application/Domain/BOT/tests/serve_napcat_fixture.py')
const available = existsSync(python) && existsSync(script)

test('real Agent tools + Core HTTP/ORM resolve an empty call and isolate two accounts and an empty account',
  { skip: available ? false : 'Standalone Agent checkout has no sibling Core test environment', timeout: 30000 }, async t => {
    const child = spawn(python, ['-B', script], { cwd: core, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(async () => {
      if (child.exitCode !== null) return
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    })
    const ready = await new Promise<{ port: number; bot_a: string }>((resolve, reject) => {
      let output = '', errors = ''
      const timer = setTimeout(() => reject(new Error(`Core fixture startup timed out: ${errors}`)), 12000)
      child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-1500) })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Core fixture exited (${code}): ${errors}`)) })
      child.stdout.on('data', bytes => {
        output += String(bytes)
        const line = output.split('\n').find(item => item.startsWith('EDEN_QQ_HTTP_FIXTURE '))
        if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('EDEN_QQ_HTTP_FIXTURE '.length))) }
      })
    })
    const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
    t.after(() => database.close())
    const connections = new MonConnectionRepository(database)
    const permissions = new PermissionService(database, repository.events)
    permissions.setMode('full_access')
    const client = new NapcatClient(repository)
    const query = async (suffix: string) => {
      const session = repository.create(`HTTP ${suffix}`, [], {}, { purpose: 'user_chat', sourceChannel: 'app' })
      database.transaction(() => connections.saveInTransaction(session.id,
        { coreBaseUrl: `http://127.0.0.1:${ready.port}`, coreToken: `fixture-${suffix}` }))
      const tool = napcatTools(client, permissions, session.id, randomUUID()).find(item => item.name === 'list_qq_capabilities')!
      return tool.execute({}, { callId: 'real-http', signal: new AbortController().signal })
    }
    const first = await query('a') as { status: string; bot_id: string; result: { protocol: string; actions: Record<string, unknown> } }
    assert.equal(first.status, 'success'); assert.equal(first.bot_id, ready.bot_a)
    assert.equal(first.result.protocol, 'napcat-action.v1'); assert.ok(first.result.actions.get_group_list)
    const second = await query('b') as { status: string; bots: { bot_qq: string }[] }
    assert.equal(second.status, 'selection_required')
    assert.deepEqual(new Set(second.bots.map(bot => bot.bot_qq)), new Set(['222222', '333333']))
    assert.ok(!JSON.stringify(second).includes('111111'))
    const empty = await query('empty') as { status: string; bots: unknown[] }
    assert.equal(empty.status, 'not_configured'); assert.deepEqual(empty.bots, [])
    const again = await query('a') as { status: string; bot_id: string }
    assert.equal(again.status, 'success'); assert.equal(again.bot_id, ready.bot_a)
  })
