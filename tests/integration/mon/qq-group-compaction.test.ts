import assert from 'node:assert/strict'
import test from 'node:test'
import { toJson } from '@eden/api'
import { createRuntime } from '@eden/runtime-pi'
import { callbacks, recordedModel } from '@eden/runtime-pi/testing'
import { qqGroupTurnContext } from '../../../src/model-prompts/qq-group-context.ts'

test('group reference survives automatic compaction without entering its summary or durable checkpoint', async () => {
  const model = await recordedModel([{ text: 'A'.repeat(11000) }, { text: 'SUMMARY: completed old task' }, { text: 'Continued' }])
  const config = { ...model.config, contextWindow: 10000 }, record = callbacks()
  const environment = { channelAudience: 'qq_group', botQq: '100001', groupQq: '300001', contactQq: '200002' }
  const context = qqGroupTurnContext({ environment, channelContext: toJson({
    schema_version: 'qq-group-context.v1', bot_qq: '100001', group_qq: '300001', operator_qq: '200002',
    speaker_name: 'B', summaries: [], messages: [{ message_id: 'budget-original', role: 'user', sender_qq: '200001',
      sender_name: 'A', timestamp: '', content: 'EPHEMERAL_GROUP_REFERENCE_500' }],
  }) }, 2000)
  try {
    const initial = createRuntime({ sessionId: 'group-compaction', systemPrompt: '', model: config, tools: [], callbacks: record.handlers })
    await initial.prompt('OLD '.repeat(1750))
    const runtime = createRuntime({ sessionId: 'group-compaction', systemPrompt: '', model: config, tools: [],
      callbacks: record.handlers, checkpoint: await initial.snapshot(), turnContext: context })
    await runtime.prompt('CURRENT '.repeat(1000))
    assert.equal(model.requests.length, 3)
    assert.doesNotMatch(JSON.stringify(model.requests[1]), /EPHEMERAL_GROUP_REFERENCE_500/)
    assert.match(JSON.stringify(model.requests[2]), /EPHEMERAL_GROUP_REFERENCE_500/)
    assert.match(JSON.stringify(model.requests[2]), /SUMMARY: completed old task/)
    const snapshot = await runtime.snapshot()
    assert.ok(snapshot.entries.some(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.type === 'compaction'))
    assert.doesNotMatch(JSON.stringify(snapshot), /EPHEMERAL_GROUP_REFERENCE_500/)
    assert.ok(record.events.some(event => event.kind === 'auto_compaction_start'))
  } finally { await model.close() }
})
