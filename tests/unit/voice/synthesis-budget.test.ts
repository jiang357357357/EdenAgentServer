import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { OperationFailure, type VoiceSynthesizeInput } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { SynthesisBudget } from '../../../src/modules/voice/synthesis-budget.ts'
test('failure budget survives rewrites and instance restart; manual retry is scoped to one message', () => {
  const db = new EdenDatabase(':memory:', 'mon'), sessions = new SessionRepository(db, 'mon'), session = sessions.create('voice')
  try {
    const input: VoiceSynthesizeInput = { sessionId: session.id, messageId: 'one', configId: 1, text: 'same text', mode: 'text_only', intent: 'auto', segmentGroupId: 'first', groupIndex: 0, sequence: 0 }
    const budget = new SynthesisBudget(sessions)
    for (let index = 0; index < 4; index++) { budget.check({ ...input, segmentGroupId: `rewrite:${index}` }); budget.failed(input, new Error('temporary')) }
    assert.throws(() => new SynthesisBudget(sessions).check({ ...input, segmentGroupId: 'another-rewrite' }), /自动语音已暂停/)
    budget.check({ ...input, messageId: 'other' })
    budget.failed({ ...input, messageId: 'other' }, new OperationFailure('invalid config', { kind: 'fixture', outcome: 'failed', retryable: false }))
    budget.prepare({ ...input, intent: 'manual' }); budget.check(input)
    assert.throws(() => budget.check({ ...input, messageId: 'other' }), /自动语音已暂停/)
    assert.equal(sessions.events.list(session.id).filter(event => event.kind === 'voice.retry_requested').length, 1)
  } finally { db.close() }
})
