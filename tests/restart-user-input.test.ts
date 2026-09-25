import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordedModel } from '@eden/runtime-pi/testing'
import { loadConfig } from '../src/bootstrap/config.ts'
import { startServer } from '../src/bootstrap/container.ts'
import { InputRepository } from '../src/modules/sessions/input/input-repository.ts'
import { InputRecoveryRepository } from '../src/modules/sessions/input/recovery-repository.ts'

test('a real server restart holds unstarted user input until a new explicit request', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-restart-user-input-'))
  const model = await recordedModel([{ text: 'New request completed' }])
  const config = { ...loadConfig({ EDEN_AGENT_DATA_ROOT: root, EDEN_AGENT_PORT: '0' }), model: model.config }
  let server = await startServer(config)
  context.after(async () => {
    await server.close()
    await model.close()
    await rm(root, { recursive: true, force: true })
  })
  const repository = server.sessions.repository
  const session = repository.create('Restart recovery')
  // Persist an accepted input before the executor can claim it, as can happen at shutdown.
  const pending = new InputRepository(repository.database, repository.events)
    .enqueue(session.id, 'Old request', 'before-restart')
  await server.close()
  server = await startServer(config)
  await server.sessions.waitForIdle(session.id)
  const database = server.sessions.repository.database.connection
  assert.equal(database.prepare('SELECT state FROM inputs WHERE id=?').get(pending.inputId)?.state, 'held')
  assert.equal(model.requests.length, 0)
  assert.equal(new InputRecoveryRepository(server.sessions.repository).list(session.id).items[0]?.id, pending.inputId)

  const fresh = server.sessions.start(session.id, 'New request')
  await server.sessions.waitForIdle(session.id)
  assert.equal(database.prepare('SELECT state FROM inputs WHERE id=?').get(fresh.inputId)?.state, 'completed')
  assert.equal(database.prepare('SELECT state FROM inputs WHERE id=?').get(pending.inputId)?.state, 'held')
  assert.equal(model.requests.length, 1)
})
