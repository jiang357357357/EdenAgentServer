import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import type { RuntimeModel, RuntimeTool } from '@eden/runtime-pi'
import type { RecordedReply } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionService } from '../../../src/modules/sessions/index.ts'

export async function faultFixture(t: TestContext, replies: RecordedReply[] = [{ text: 'Recovered reply' }], origin: 'mon' | 'local' = 'local') {
  const database = new EdenDatabase(':memory:', origin), repository = new SessionRepository(database, origin)
  const model = await recordedModel(replies)
  let configuration: RuntimeModel = model.config, tools: RuntimeTool[] = [], toolFailure: Error | undefined
  const sessions = new SessionService(repository, () => configuration, () => { if (toolFailure) throw toolFailure; return tools })
  t.after(async () => { await sessions.close(); database.close(); await model.close() })
  const input = (id: string) => database.connection.prepare('SELECT * FROM inputs WHERE id=?').get(id)!
  const events = (id: string) => repository.events.list(id, '0', 1000)
  const assertCompleted = (id: string) => assert.equal(input(id).state, 'completed')
  return { database, repository, model, sessions, input, events, assertCompleted,
    setModel(value: RuntimeModel) { configuration = value }, setTools(value: RuntimeTool[]) { tools = value },
    failTools(value?: Error) { toolFailure = value } }
}
