import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { PermissionService } from '../../../src/modules/permissions/index.ts'
import { NapcatClient } from '../../../src/modules/mon/napcat-client.ts'
import { napcatTools } from '../../../src/modules/mon/napcat-tools.ts'
import { sendNapcatRequest } from '../../../src/modules/mon/napcat-transport.ts'

const core = path.resolve('../Core')
const python = path.join(core, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const script = path.join(core, 'Application/Domain/BOT/tests/serve_group_agent_fixture.py')

test('signed Agent tools admit ordinary group speakers through real Core HTTP while preserving private and write gates',
  { skip: existsSync(python) && existsSync(script) ? false : 'Sibling Core test environment is unavailable', timeout: 30000 }, async t => {
    const child = spawn(python, ['-B', script], { cwd: core, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(async () => {
      if (child.exitCode !== null) return
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    })
    const ready = await new Promise<{ port: number; user_id: string; secret: string }>((resolve, reject) => {
      let output = '', errors = ''
      const timer = setTimeout(() => reject(new Error(`Core fixture timed out: ${errors}`)), 12000)
      child.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-1500) })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Core fixture exited (${code}): ${errors}`)) })
      child.stdout.on('data', bytes => {
        output += String(bytes)
        const line = output.split('\n').find(item => item.startsWith('EDEN_GROUP_HTTP_FIXTURE '))
        if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('EDEN_GROUP_HTTP_FIXTURE '.length))) }
      })
    })
    const identity = { coreBaseUrl: `http://127.0.0.1:${ready.port}`, userId: ready.user_id, secret: ready.secret }
    const database = new EdenDatabase(':memory:', 'mon'), repository = new SessionRepository(database, 'mon')
    t.after(() => database.close())
    const permissions = new PermissionService(database, repository.events)
    const client = new NapcatClient(repository, identity)
    const groupTools = (contact: string, group = '300001', actions = false) => {
      const session = repository.create('Group', [{ assistantId: 1, characterId: 2 }],
        { channelAudience: 'qq_group' }, { purpose: 'user_chat', sourceChannel: 'qq' })
      database.connection.prepare('INSERT INTO qq_group_sessions VALUES(?,?,?,?,?,?)')
        .run(session.id, '100001', group, contact, Number(actions), Date.now())
      const tools = napcatTools(client, permissions, session.id, randomUUID())
      return { target: client.target(session.id), tool: (name: string) => tools.find(item => item.name === name)! }
    }
    const context = { callId: 'signed-group', signal: new AbortController().signal }
    const member = groupTools('200002')
    const catalog = await member.tool('list_qq_capabilities').execute({}, context) as {
      status: string; result: { actions: Record<string, { target: string; mutating: boolean }> }
    }
    assert.equal(catalog.status, 'success')
    assert.ok(catalog.result.actions.get_group_info)
    assert.ok(Object.values(catalog.result.actions).every(spec => spec.target === 'group' && !spec.mutating))
    const read = await member.tool('read_qq_action').execute({ action: 'get_group_info', params: {} }, context)
    assert.equal((read as { status: string }).status, 'success')
    // Core must reject a forged/stale host write flag even if the Agent allows its local permission.
    const forged = groupTools('200002', '300001', true)
    const refused = await sendNapcatRequest(forged.target, { action: 'set_group_name',
      params: { group_id: '300001', group_name: 'new' }, mode: 'write', request_id: randomUUID() }, context.signal)
    assert.equal(refused.status, 'failed'); assert.equal(refused.code, 'HTTP_403')
    const admin = groupTools('200001', '300001', true)
    const write = await admin.tool('execute_qq_action').execute({ action: 'set_group_name', params: { group_name: 'new' } }, context)
    assert.equal((write as { status: string }).status, 'success')
    for (const [contact, group] of [['200003', '300001'], ['200002', '300002'], ['200002', '300003']]) {
      const rejected = groupTools(contact!, group!)
      const result = await rejected.tool('list_qq_capabilities').execute({}, context) as { status: string; code: string }
      assert.equal(result.status, 'failed'); assert.equal(result.code, 'HTTP_403')
    }
    const privateSession = repository.create('Private', [{ assistantId: 1, characterId: 2 }], {},
      { purpose: 'user_chat', sourceChannel: 'qq' })
    database.connection.prepare('INSERT INTO qq_channel_conversations VALUES(?,?,?,?)')
      .run('100001', '200002', privateSession.id, Date.now())
    const denied = await client.capabilities(client.target(privateSession.id), randomUUID(), context.signal)
    assert.equal(denied.status, 'failed'); assert.equal(denied.code, 'HTTP_403')
    const wrongIdentity = new NapcatClient(repository, { ...identity, secret: 'invalid-fixture-secret' })
    const invalid = await wrongIdentity.capabilities(wrongIdentity.target(member.target.sessionId), randomUUID(), context.signal)
    assert.equal(invalid.status, 'failed')
  })
