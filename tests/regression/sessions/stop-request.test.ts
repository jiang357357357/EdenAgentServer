import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'
import { sessionRoutes } from '../../../src/transport/rpc/session.routes.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('stop signals the current tool before waiting for descendants and cannot run queued work later', { timeout: 10000 }, async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local')
  const model = await recordedModel([{ tool: 'wait', input: {} }, { text: 'Unexpected continuation' }])
  const toolEntered = gate(), toolRelease = gate(), descendantsEntered = gate(), descendantsRelease = gate()
  let toolSignal: AbortSignal | undefined
  const sessions = new SessionService(repository, model.config, () => [{
    name: 'wait', description: 'Wait for release', revision: '1', parameters: { type: 'object' },
    async execute(_input, context) {
      toolSignal = context.signal
      toolEntered.release()
      await toolRelease.promise
      return null
    },
  }])
  sessions.setDescendantStop(async () => {
    descendantsEntered.release()
    await descendantsRelease.promise
  })
  try {
    const session = repository.create('Stop a busy turn')
    sessions.start(session.id, 'Start tool', 'first')
    await toolEntered.promise
    sessions.start(session.id, 'Queued follow-up', 'second')

    const stopping = sessions.cancel(session.id)
    await descendantsEntered.promise
    assert.equal(toolSignal?.aborted, true, 'the running tool receives cancellation before descendants finish')
    assert.equal(sessions.isRunning(session.id), true)
    assert.equal((await sessionRoutes(sessions)['session.read']!({ sessionId: session.id }) as { executionStatus: string }).executionStatus, 'busy')
    const listed = await sessionRoutes(sessions)['session.list']!({ limit: 20, includeClosed: false, includeBackground: false }) as Array<{ id: string; executionStatus: string }>
    assert.equal(listed.find(item => item.id === session.id)?.executionStatus, 'busy')
    assert.throws(() => sessions.start(session.id, 'Too early'), /stopping/)
    assert.equal(database.connection.prepare("SELECT state FROM inputs WHERE idempotency_key='second'").get()?.state, 'cancelled')

    toolRelease.release()
    descendantsRelease.release()
    assert.equal(await stopping, true)
    await sessions.waitForIdle(session.id)
    assert.equal(database.connection.prepare("SELECT state FROM inputs WHERE idempotency_key='first'").get()?.state, 'interrupted')
    assert.equal(model.requests.length, 1, 'stopping does not start another model request')
    assert.equal(repository.read(session.id).executionStatus, 'idle')
    assert.equal(sessions.isRunning(session.id), false)
  } finally {
    toolRelease.release()
    descendantsRelease.release()
    await sessions.close()
    await model.close()
    database.close()
  }
})

test('stop cancels an unstarted queued input and returns an idle snapshot', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local')
  const model = await recordedModel([{ text: 'Must not run' }])
  const sessions = new SessionService(repository, model.config, undefined, undefined, undefined,
    { pendingSessions: () => [], run: async () => false })
  try {
    const session = repository.create('Queued at boundary')
    sessions.start(session.id, 'Wait for boundary', 'queued')
    await sessions.waitForIdle(session.id)
    assert.equal(repository.read(session.id).executionStatus, 'busy')
    assert.equal(await sessions.cancel(session.id), true)
    assert.equal(repository.read(session.id).executionStatus, 'idle')
    assert.equal(database.connection.prepare("SELECT state FROM inputs WHERE idempotency_key='queued'").get()?.state, 'cancelled')
    assert.equal(repository.events.list(session.id, '0', 100).filter(event => event.kind === 'input.cancelled').length, 1)
    sessions.resumePending()
    await sessions.waitForIdle(session.id)
    assert.equal(model.requests.length, 0)
  } finally {
    await sessions.close()
    await model.close()
    database.close()
  }
})
