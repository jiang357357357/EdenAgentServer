import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DurableEvent, JsonValue, RuntimeCheckpoint } from '@eden/api'
import { EdenDatabase } from '@eden/store'
import { createRuntime, assertRuntimeCheckpoint, legacyContextCheckpoint, publicHistoryCheckpoint } from '@eden/runtime-pi'
import { recordedModel } from '@eden/runtime-pi/testing'
import type { RecordedReply } from '@eden/runtime-pi/testing'
import { MessageDeletion, SessionRepository, runtimeCallbacks, conversationWindow, recentSharedTopics } from '../../../src/modules/sessions/index.ts'
import { ActorCheckpointRepository, ActorExecutionService } from '../../../src/modules/actors/index.ts'
import { parseDirectorPlan } from '../../../src/modules/director/index.ts'
import { MemoryExtractionRepository } from '../../../src/modules/memories/index.ts'
import { InputRepository } from '../../../src/modules/sessions/input/input-repository.ts'
import { qqIdentifierHidden } from '../../../src/model-prompts/qq-results.ts'

async function fixture(t: TestContext, replies: RecordedReply[]) {
  const model = await recordedModel(replies), database = new EdenDatabase(':memory:', 'local')
  t.after(async () => { database.close(); await model.close() })
  const repository = new SessionRepository(database, 'local'), session = repository.create('Context deletion')
  const input = (text = 'USER_ORIGINAL') => ({ id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text, state: 'running' })
  const runtime = (checkpoint?: RuntimeCheckpoint, tools: Parameters<typeof createRuntime>[0]['tools'] = []) => createRuntime({
    sessionId: session.id, model: model.config, systemPrompt: '', tools, callbacks: runtimeCallbacks(repository, input()),
    ...(checkpoint ? { checkpoint } : {}),
  })
  const answers = () => repository.events.messages(session.id, undefined, 100).items.filter(event => object(object(event.payload).message).role === 'assistant')
  return { model, database, repository, session, runtime, answers, input, deletion: new MessageDeletion(repository) }
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function messageId(event: DurableEvent): string { return String(object(event.payload).messageId ?? event.id) }
function stored(repository: SessionRepository, sessionId: string): string {
  return String(repository.database.connection.prepare('SELECT checkpoint_json FROM runtime_checkpoints WHERE session_id=?').get(sessionId)?.checkpoint_json)
}

test('deletion commits model context before broadcasting and the next real request preserves user input and other answers', async t => {
  const f = await fixture(t, [{ text: 'REMOVED_ANSWER', thinking: 'REMOVED_THINKING' }, { text: 'RETAINED_ANSWER' }, { text: 'NEXT_ANSWER' }])
  const first = f.runtime()
  await first.prompt('USER_ORIGINAL')
  await first.prompt('USER_SECOND')
  const answer = f.answers()[0]!, before = await first.snapshot(), published: DurableEvent[] = []
  assert.equal(typeof object(answer.payload).contextEntryId, 'string')
  f.repository.events.subscribe(event => {
    if (event.kind !== 'message.deleted') return
    assert.doesNotMatch(stored(f.repository, f.session.id), /REMOVED_ANSWER|REMOVED_THINKING/)
    published.push(event)
  })
  f.deletion.remove(f.session.id, messageId(answer))
  const after = f.repository.checkpoint(f.session.id)!
  assertRuntimeCheckpoint(after, f.session.id)
  assert.match(JSON.stringify(after), /USER_ORIGINAL/)
  assert.match(JSON.stringify(after), /USER_SECOND/)
  assert.match(JSON.stringify(after), /RETAINED_ANSWER/)
  assert.doesNotMatch(JSON.stringify(after), /REMOVED_ANSWER|REMOVED_THINKING/)
  assert.match(String(f.database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(answer.id)?.payload_json), /REMOVED_ANSWER/)
  f.repository.saveCheckpoint(before, randomUUID())
  assert.doesNotMatch(stored(f.repository, f.session.id), /REMOVED_ANSWER/)
  f.deletion.remove(f.session.id, messageId(answer))
  assert.equal(published.length, 1)
  await f.runtime(f.repository.checkpoint(f.session.id)).prompt('FOLLOW_UP')
  const request = JSON.stringify(f.model.requests.at(-1)?.messages)
  assert.doesNotMatch(request, /REMOVED_ANSWER|REMOVED_THINKING/)
  assert.match(request, /USER_ORIGINAL/)
  assert.match(request, /USER_SECOND/)
  assert.match(request, /RETAINED_ANSWER/)
})

test('deleting final text retains its earlier tool pair; deleting the tool-bearing message removes its paired model receipt and preserves audit', async t => {
  const f = await fixture(t, [{ tool: 'echo', input: { text: 'TOOL_ARGUMENT' } }, { text: 'FINAL_REMOVED' },
    { text: 'FOLLOW_UP_RETAINED' }, { text: 'AFTER_TOOL_DELETION' }])
  let executions = 0
  const runtime = f.runtime(undefined, [{ name: 'echo', description: 'echo', revision: '1',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async execute() { executions++; return 'TOOL_RESULT' },
  }])
  await runtime.prompt('USER_TOOL_REQUEST')
  const [tool, final] = f.answers()
  f.deletion.remove(f.session.id, messageId(final!))
  const paired = f.repository.checkpoint(f.session.id)!
  assert.match(JSON.stringify(paired), /TOOL_ARGUMENT/)
  assert.match(JSON.stringify(paired), /TOOL_RESULT/)
  assert.doesNotMatch(JSON.stringify(paired), /FINAL_REMOVED/)
  await f.runtime(paired).prompt('FOLLOW_UP')
  assert.match(JSON.stringify(f.model.requests.at(-1)?.messages), /TOOL_RESULT/)
  f.deletion.remove(f.session.id, messageId(tool!))
  const removed = f.repository.checkpoint(f.session.id)!
  assert.doesNotMatch(JSON.stringify(removed), /TOOL_ARGUMENT|TOOL_RESULT|FINAL_REMOVED/)
  assert.match(JSON.stringify(removed), /USER_TOOL_REQUEST|FOLLOW_UP_RETAINED/)
  assert.equal(f.database.connection.prepare('SELECT COUNT(*) AS count FROM tool_operations').get()?.count, 1)
  assert.match(String(f.database.connection.prepare('SELECT result_json FROM tool_operations').get()?.result_json), /TOOL_RESULT/)
  await f.runtime(removed).prompt('NEXT')
  assert.doesNotMatch(JSON.stringify(f.model.requests.at(-1)?.messages), /TOOL_ARGUMENT|TOOL_RESULT|FINAL_REMOVED/)
  assert.equal(executions, 1)
})

test('real compaction cannot restore a deleted answer and subsequent clean summaries continue to work', async t => {
  const f = await fixture(t, [{ text: 'OLD_DELETED' }, { text: 'KEEP_REPLY' }, { text: 'OLD_SUMMARY_OLD_DELETED' },
    { text: 'NEXT_REPLY' }, { text: 'CLEAN_SUMMARY_KEEP_REPLY' }, { text: 'FINAL_REPLY' }])
  const runtime = f.runtime()
  await runtime.prompt('ORIGINAL_USER')
  await runtime.prompt('SECOND_USER')
  const answer = f.answers()[0]!
  await runtime.compact()
  assert.match(stored(f.repository, f.session.id), /OLD_SUMMARY_OLD_DELETED/)
  f.deletion.remove(f.session.id, messageId(answer))
  const projected = f.repository.checkpoint(f.session.id)!
  assert.doesNotMatch(JSON.stringify(projected), /OLD_DELETED|OLD_SUMMARY/)
  const next = f.runtime(projected)
  await next.prompt('CONTINUE')
  assert.doesNotMatch(JSON.stringify(f.model.requests[3]?.messages), /OLD_DELETED|OLD_SUMMARY/)
  assert.match(JSON.stringify(f.model.requests[3]?.messages), /ORIGINAL_USER|KEEP_REPLY/)
  await next.compact()
  const compacted = f.repository.checkpoint(f.session.id)!
  assert.match(JSON.stringify(compacted), /CLEAN_SUMMARY_KEEP_REPLY/)
  await f.runtime(compacted).prompt('AFTER_NEW_COMPACTION')
  assert.match(JSON.stringify(f.model.requests.at(-1)?.messages), /CLEAN_SUMMARY_KEEP_REPLY/)
  assert.doesNotMatch(JSON.stringify(f.model.requests.at(-1)?.messages), /OLD_DELETED|OLD_SUMMARY/)
})

test('all actor checkpoints and cached public conversation are projected without removing original user instructions', async t => {
  const one = await recordedModel([{ text: 'ACTOR_REMOVED' }, { text: 'ONE_NEXT' }])
  const two = await recordedModel([{ text: 'ACTOR_TWO_RETAINED' }, { text: 'TWO_NEXT' }])
  const database = new EdenDatabase(':memory:', 'local'), repository = new SessionRepository(database, 'local')
  const session = repository.create('Actors'), actors = new ActorExecutionService(repository), checkpoints = new ActorCheckpointRepository(repository)
  t.after(async () => { await actors.close(); database.close(); await Promise.all([one.close(), two.close()]) })
  const plan = parseDirectorPlan(JSON.stringify({ beats: [{ assistantID: 1 }, { assistantID: 2 }] }),
    [{ assistantId: 1 }, { assistantId: 2 }], 'fixture')
  const execute = (assistantId: number, text: string, conversation: JsonValue[]) => actors.execute({
    input: { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text, state: 'running' }, plan,
    beatIndex: assistantId - 1, participant: { assistantId }, model: assistantId === 1 ? one.config : two.config,
    tools: [], conversation, signal: new AbortController().signal,
  })
  await execute(1, 'USER_FOR_ONE', [])
  const first = repository.events.messages(session.id, undefined, 100).items[0]!, oldOne = checkpoints.read(session.id, 1)!
  await execute(2, 'USER_FOR_TWO', conversationWindow([first.payload]))
  assert.match(JSON.stringify(checkpoints.read(session.id, 2)), /ACTOR_REMOVED/)
  new MessageDeletion(repository).remove(session.id, messageId(first))
  checkpoints.save(session.id, 1, randomUUID(), oldOne)
  for (const row of database.connection.prepare('SELECT checkpoint_json FROM actor_checkpoints WHERE session_id=?').all(session.id)) {
    assert.doesNotMatch(String(row.checkpoint_json), /ACTOR_REMOVED/)
  }
  assert.match(JSON.stringify(checkpoints.read(session.id, 1)), /USER_FOR_ONE/)
  assert.match(JSON.stringify(checkpoints.read(session.id, 2)), /USER_FOR_TWO|ACTOR_TWO_RETAINED/)
  const visible = conversationWindow(repository.events.messages(session.id, undefined, 100).items.map(event => event.payload))
  await execute(1, 'ONE_FOLLOW_UP', visible)
  await execute(2, 'TWO_FOLLOW_UP', visible)
  assert.doesNotMatch(JSON.stringify(one.requests.at(-1)?.messages), /ACTOR_REMOVED/)
  assert.doesNotMatch(JSON.stringify(two.requests.at(-1)?.messages), /ACTOR_REMOVED/)
  assert.match(JSON.stringify(two.requests.at(-1)?.messages), /USER_FOR_TWO|ACTOR_TWO_RETAINED/)
})

test('handoff and imported history lose only the deleted assistant snapshots and preserve their user messages', async t => {
  const f = await fixture(t, [{ text: 'HANDOFF_DELETED' }, { text: 'HANDOFF_NEXT' }])
  await f.runtime().prompt('USER_BEFORE_HANDOFF')
  const answer = f.answers()[0]!, source = object(answer.payload).message!
  const user: JsonValue = { role: 'user', content: 'USER_IMPORTED', timestamp: 1 }
  const history = legacyContextCheckpoint(f.session.id, [user, source], Date.now())
  const handoff = publicHistoryCheckpoint(f.session.id, [{ role: 'user', text: 'USER_HANDOFF' },
    { role: 'assistant', text: 'HANDOFF_DELETED' }, { role: 'assistant', text: 'HANDOFF_KEEP' }], history)
  f.repository.saveCheckpoint(handoff, randomUUID())
  f.deletion.remove(f.session.id, messageId(answer))
  assert.doesNotMatch(stored(f.repository, f.session.id), /HANDOFF_DELETED/)
  assert.match(stored(f.repository, f.session.id), /USER_IMPORTED|USER_HANDOFF|HANDOFF_KEEP/)
  await f.runtime(f.repository.checkpoint(f.session.id)).prompt('FOLLOW_UP')
  assert.doesNotMatch(JSON.stringify(f.model.requests.at(-1)?.messages), /HANDOFF_DELETED/)
  assert.match(JSON.stringify(f.model.requests.at(-1)?.messages), /USER_HANDOFF|HANDOFF_KEEP/)
})

test('previous display-only deletion and pre-link events stay deleted after temporary database reopen and stale writes', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'eden-context-deletion-')), filename = join(scratch, 'fixture.sqlite')
  const model = await recordedModel([{ text: 'LEGACY_REMOVED' }, { text: 'RESTORED_REPLY' }])
  let database = new EdenDatabase(filename, 'local')
  t.after(async () => { database.close(); await model.close()
    if (dirname(resolve(scratch)) !== resolve(tmpdir())) throw new Error('Unexpected fixture cleanup path')
    rmSync(scratch, { recursive: true, force: true }) })
  let repository = new SessionRepository(database, 'local')
  const session = repository.create('Reopen')
  const runtime = createRuntime({ sessionId: session.id, model: model.config, systemPrompt: '', tools: [],
    callbacks: runtimeCallbacks(repository, { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'LEGACY_USER', state: 'running' }) })
  await runtime.prompt('LEGACY_USER')
  const answer = repository.events.messages(session.id, undefined, 100).items.at(-1)!, snapshot = repository.checkpoint(session.id)!
  database.connection.prepare("UPDATE events SET payload_json=json_remove(payload_json,'$.contextEntryId') WHERE id=?").run(answer.id)
  repository.events.append(session.id, null, 'message.deleted', { messageId: messageId(answer) })
  assert.match(stored(repository, session.id), /LEGACY_REMOVED/)
  database.close(); database = new EdenDatabase(filename, 'local'); repository = new SessionRepository(database, 'local')
  assert.doesNotMatch(JSON.stringify(repository.checkpoint(session.id)), /LEGACY_REMOVED/)
  repository.saveCheckpoint(snapshot, randomUUID())
  assert.doesNotMatch(stored(repository, session.id), /LEGACY_REMOVED/)
  await createRuntime({ sessionId: session.id, model: model.config, systemPrompt: '', tools: [], checkpoint: repository.checkpoint(session.id)!,
    callbacks: runtimeCallbacks(repository, { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), text: 'NEXT', state: 'running' }) }).prompt('NEXT')
  assert.doesNotMatch(JSON.stringify(model.requests.at(-1)?.messages), /LEGACY_REMOVED/)
  assert.match(JSON.stringify(model.requests.at(-1)?.messages), /LEGACY_USER/)
})

test('checkpoint update failure rolls back both message deletion and context redaction before publication', async t => {
  const f = await fixture(t, [{ text: 'ROLLBACK_ANSWER' }])
  await f.runtime().prompt('ROLLBACK_USER')
  const answer = f.answers()[0]!, original = stored(f.repository, f.session.id), published: DurableEvent[] = []
  f.repository.events.subscribe(event => { if (event.kind === 'message.deleted') published.push(event) })
  f.database.connection.exec("CREATE TRIGGER reject_context_delete BEFORE UPDATE ON runtime_checkpoints BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END")
  assert.throws(() => f.deletion.remove(f.session.id, messageId(answer)), /fixture disk failure/)
  assert.equal(stored(f.repository, f.session.id), original)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='message.deleted'").get()?.count, 0)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.length, 2)
  assert.equal(published.length, 0)
  f.database.connection.exec('DROP TRIGGER reject_context_delete')
  const foreign = f.repository.create('Wrong checkpoint scope')
  f.database.connection.prepare('INSERT INTO actor_checkpoints VALUES(?,?,?,?)')
    .run(f.session.id, '1', JSON.stringify({ ...f.repository.checkpoint(f.session.id), sessionId: foreign.id }), Date.now())
  assert.throws(() => f.deletion.remove(f.session.id, messageId(answer)), /checkpoint session mismatch/)
  assert.equal(stored(f.repository, f.session.id), original, 'main checkpoint rewrite must roll back after a later actor failure')
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='message.deleted'").get()?.count, 0)
  assert.equal(published.length, 0)
})

test('an explicit runtime entry link distinguishes separate assistant messages with identical content and timestamps', async t => {
  const f = await fixture(t, [{ text: 'IDENTICAL_BODY' }])
  await f.runtime().prompt('USER_INPUT')
  const answer = f.answers()[0]!, original = f.repository.checkpoint(f.session.id)!
  const first = original.entries.find(value => object(object(value).message).role === 'assistant')!
  const duplicate: JsonValue = { ...object(first), id: 'separate-entry', parentId: String(object(first).id) }
  f.repository.saveCheckpoint({ ...original, entries: [...original.entries, duplicate] }, randomUUID())
  f.deletion.remove(f.session.id, messageId(answer))
  const kept = f.repository.checkpoint(f.session.id)!.entries.filter(value => object(object(value).message).role === 'assistant')
  assert.equal(kept.length, 1)
  assert.equal(object(kept[0]).id, 'separate-entry')
  assert.match(JSON.stringify(kept), /IDENTICAL_BODY/)
})

test('new shared-topic and memory-extraction sources omit deleted replies while keeping the human input and audit', async t => {
  const f = await fixture(t, [{ text: 'TOPIC_REMOVED' }]), participant = { assistantId: 1, characterId: 10 }
  f.repository.setMetadata(f.session.id, [participant])
  const inputs = new InputRepository(f.database, f.repository.events)
  const accepted = inputs.enqueue(f.session.id, 'TOPIC_USER', randomUUID(), { participants: [participant] })
  const input = inputs.claim(f.session.id)!
  const runtime = createRuntime({ sessionId: f.session.id, model: f.model.config, systemPrompt: '', tools: [], callbacks: runtimeCallbacks(f.repository, input) })
  await runtime.prompt('TOPIC_USER'); inputs.finish(input)
  assert.match(JSON.stringify(recentSharedTopics(f.database, f.session.id, participant)), /TOPIC_REMOVED/)
  const answer = f.answers()[0]!
  f.deletion.remove(f.session.id, messageId(answer))
  const topics = recentSharedTopics(f.database, f.session.id, participant)
  assert.doesNotMatch(JSON.stringify(topics), /TOPIC_REMOVED/)
  assert.match(JSON.stringify(topics), /TOPIC_USER/)
  assert.equal(topics[0]?.replyAvailable, false)
  assert.equal(new MemoryExtractionRepository(f.database).schedule(accepted.inputId), undefined)
  assert.match(String(f.database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(answer.id)?.payload_json), /TOPIC_REMOVED/)
})

test('pre-link answers remain deletable after QQ privacy projection has changed their stored content', async t => {
  const f = await fixture(t, [{ tool: 'execute_qq_action', input: {} },
    { text: 'LEGACY_PRIVATE_REPLY native-legacy-tid' }, { text: 'NEXT_PRIVATE_REPLY' }])
  const tool = { name: 'execute_qq_action', revision: '1', description: 'fixture',
    parameters: { type: 'object', properties: {} }, async execute() { return { tid: 'native-legacy-tid' } } }
  await f.runtime(undefined, [tool]).prompt('LEGACY_PRIVATE_USER')
  const answer = f.answers().at(-1)!
  f.database.connection.prepare("UPDATE events SET payload_json=json_remove(payload_json,'$.contextEntryId') WHERE id=?").run(answer.id)
  const privateSnapshot = f.repository.checkpoint(f.session.id)!
  assert.doesNotMatch(JSON.stringify(privateSnapshot), /native-legacy-tid/)
  f.repository.saveCheckpoint(publicHistoryCheckpoint(f.session.id, [{ role: 'user', text: 'LEGACY_PRIVATE_USER' },
    { role: 'assistant', text: `LEGACY_PRIVATE_REPLY ${qqIdentifierHidden}` }], privateSnapshot), randomUUID())
  f.deletion.remove(f.session.id, messageId(answer))
  assert.doesNotMatch(stored(f.repository, f.session.id), /LEGACY_PRIVATE_REPLY/)
  assert.match(String(f.database.connection.prepare('SELECT payload_json FROM events WHERE id=?').get(answer.id)?.payload_json), /native-legacy-tid/)
  await f.runtime(f.repository.checkpoint(f.session.id), [tool]).prompt('AFTER_PRIVATE_DELETE')
  assert.doesNotMatch(JSON.stringify(f.model.requests.at(-1)?.messages), /LEGACY_PRIVATE_REPLY|native-legacy-tid/)
  assert.match(JSON.stringify(f.model.requests.at(-1)?.messages), /LEGACY_PRIVATE_USER/)
})

test('ambiguous pre-link assistant identities fail atomically instead of removing multiple answers', async t => {
  const f = await fixture(t, [{ text: 'AMBIGUOUS_REPLY' }])
  await f.runtime().prompt('AMBIGUOUS_USER')
  const answer = f.answers()[0]!, snapshot = f.repository.checkpoint(f.session.id)!, entry = object(snapshot.entries.at(-1))
  const duplicate = { ...snapshot, entries: [...snapshot.entries, { ...entry, id: 'duplicate-legacy', parentId: entry.id! }] }
  f.repository.saveCheckpoint(duplicate, randomUUID())
  f.database.connection.prepare("UPDATE events SET payload_json=json_remove(payload_json,'$.contextEntryId') WHERE id=?").run(answer.id)
  const original = stored(f.repository, f.session.id)
  assert.throws(() => f.deletion.remove(f.session.id, messageId(answer)), /uniquely locate/)
  assert.equal(stored(f.repository, f.session.id), original)
  assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='message.deleted'").get()?.count, 0)
  assert.equal(f.repository.events.messages(f.session.id, undefined, 100).items.length, 2)
})
