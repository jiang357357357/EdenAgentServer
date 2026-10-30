import assert from 'node:assert/strict'
import test from 'node:test'
import { toJson } from '@eden/api'
import { capabilityFixture, fixtureTool } from './fixture.ts'

for (const change of ['removed', 'revision', 'actor', 'workspace', 'channel', 'denied', 'cancelled'] as const) {
  test(`deferred tool approval still blocks execution when ${change}`, async t => {
    const f = await capabilityFixture(); t.after(() => f.close())
    f.permissions.setMode('restricted')
    let effects = 0
    const tool = { ...fixtureTool(), async execute(input: Record<string, unknown>, context: Parameters<ReturnType<typeof fixtureTool>['execute']>[1]) {
      await f.permissions.request({ ...context, sessionId: f.session.id, turnId: f.turnId }, 'skill.execute', 'fixture', toJson(input))
      effects++
      return { ok: true }
    } }
    f.setTools([tool])
    const deferred = f.capabilities().registeredTools().find(item => item.name === tool.name)!
    assert.equal(deferred.exposure, 'deferred')
    const resolved = deferred.resolveCall!({})
    const controller = new AbortController()
    const pending = resolved.tool.execute(resolved.input, { callId: 'guard', signal: controller.signal, assertCurrent: resolved.tool.assertCurrent! })
    const rejected = assert.rejects(pending, /unavailable|changed|denied|cancelled|abort/i)
    const request = f.permissions.list().find(item => item.state === 'pending')!
    assert.ok(request)
    if (change === 'removed') f.setTools([])
    if (change === 'revision') f.setTools([{ ...tool, revision: 'updated' }])
    if (change === 'actor') f.setOwner('another-actor')
    if (change === 'workspace') f.setWorkspace('/another-workspace')
    if (change === 'channel') f.setChannel('qq')
    if (change === 'cancelled') controller.abort()
    else f.permissions.resolve(request.id, change !== 'denied')
    await rejected
    assert.equal(effects, 0)
  })
}

test('an old unshown definition cannot cross an actor or workspace change before invocation', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.setTools([fixtureTool()])
  const captured = f.capabilities().registeredTools().find(tool => tool.name === 'special_action')!
  f.setOwner('another-actor')
  assert.throws(() => captured.resolveCall!({}), /scope changed/)
  f.setOwner(''); f.setWorkspace('/another-workspace')
  assert.throws(() => captured.resolveCall!({}), /scope changed/)
})

test('complete execution registration still excludes desktop and plugin tools from QQ', async t => {
  const f = await capabilityFixture(); t.after(() => f.close())
  f.setTools([fixtureTool('web_search'), fixtureTool('desktop_observe'), { ...fixtureTool('read_file'), source: 'plugin' }])
  assert.ok(f.capabilities().registeredTools().some(tool => tool.name === 'desktop_observe'))
  f.setChannel('qq')
  assert.deepEqual(f.capabilities().registeredTools().map(tool => tool.name), ['web_search'])
  assert.equal(f.capabilities().loadTools([{ id: 'builtin:desktop_observe' }]).failed.length, 1)
})
