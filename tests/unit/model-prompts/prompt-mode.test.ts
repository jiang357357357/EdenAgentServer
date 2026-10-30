import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promptModeSchema, promptModeUpdateSchema } from '@eden/api'
import { createPromptModeSnapshot } from '../../../src/model-prompts/prompt-mode.ts'
import { BUILTIN_PROMPT_MODE_TEMPLATE, BUILTIN_PROMPT_MODE_VERSION } from '../../../src/model-prompts/prompt-mode-v3.ts'
import { sessionPromptContent } from '../../../src/modules/sessions/turn/session-prompt.ts'
import { actorSystemContent } from '../../../src/modules/actors/actor-prompt.ts'
import { requestContext } from '../../../src/modules/sessions/turn/request-context.ts'

const identity = '你是普拉娜，称呼用户为老师。'
const participant = { assistantId: 1, characterId: 1, profile: { character: {
  name: '普拉娜', system_prompt: identity, personality: '认真',
} } }
const template = BUILTIN_PROMPT_MODE_TEMPLATE

test('mode is a single system section, separate from a single identity and descriptive character JSON', () => {
  const metadata = { participants: [participant], promptMode: createPromptModeSnapshot({ enabled: true }) }
  const before = JSON.stringify(metadata)
  for (const context of [sessionPromptContent(metadata), actorSystemContent(participant, metadata)]) {
    assert.equal(context.prompt.split(template).length - 1, 1)
    assert.equal(context.prompt.split(identity).length - 1, 1)
    assert.equal(context.sources.filter(source => source.title === '超限模式').length, 1)
    assert.equal(context.sources.find(source => source.title === '超限模式')?.kind, 'system')
    const character = JSON.stringify(context.sources.find(source => source.title === '角色人设')?.content)
    assert.match(character, /认真/)
    assert.doesNotMatch(character, /system_prompt|systemPrompt|MODE: SANDBOX/)
    const usage = requestContext({ payload: { messages: [{ role: 'system', content: context.prompt }] } }, metadata, null)
    assert.ok(Number(usage.character) > 0)
  }
  assert.equal(JSON.stringify(metadata), before)
})

test('disabled, legacy and environment fields do not enable a mode or leak its inactive text', () => {
  for (const metadata of [
    { participants: [participant] },
    { participants: [participant], promptMode: { enabled: false, template } },
    { participants: [participant], environment: { promptMode: { enabled: true, template } } },
  ]) {
    for (const context of [sessionPromptContent(metadata), actorSystemContent(participant, metadata)]) {
      assert.doesNotMatch(context.prompt, /MODE: SANDBOX|超限模式提示词/)
      assert.ok(!context.sources.some(source => source.title === '超限模式'))
    }
  }
})

test('selected actor keeps its own identity without importing another role prompt', () => {
  const other = { assistantId: 2, profile: { systemPrompt: 'OTHER_ROLE_IDENTITY', name: '其他角色' } }
  const metadata = { participants: [participant, other], promptMode: createPromptModeSnapshot({ enabled: true }) }
  const context = actorSystemContent(other, metadata)
  assert.equal(context.prompt.split('OTHER_ROLE_IDENTITY').length - 1, 1)
  assert.doesNotMatch(context.prompt, /你是普拉娜/)
  assert.equal(context.prompt.split(template).length - 1, 1)
})

test('public mode accepts only a switch and rejects caller-supplied templates and authority', () => {
  assert.deepEqual(promptModeSchema.parse({ enabled: true }), { enabled: true })
  for (const value of [
    { enabled: true, template }, { enabled: false, template: '' }, { enabled: 'true' },
    { enabled: true, permissions: 'all' },
  ]) assert.equal(promptModeSchema.safeParse(value).success, false)
  assert.equal(promptModeUpdateSchema.safeParse({ enabled: true, expectedUpdatedAt: 0, template }).success, false)
  assert.throws(() => sessionPromptContent({ promptMode: { enabled: true, template: '' } }))
})

test('built-in first edition is byte-identical to the evaluated upstream v3', () => {
  assert.equal(BUILTIN_PROMPT_MODE_VERSION, 'v3')
  assert.equal(template.length, 1420)
  assert.equal(Buffer.byteLength(template, 'utf8'), 1516)
  assert.equal(createHash('sha256').update(template).digest('hex'), '8b6062681fe2bd985632b738801a8472ec7f6a1d5dd7b8134396e9a934658a3a')
  assert.equal(createPromptModeSnapshot({ enabled: true }).templateVersion, 'v3')
})

test('already admitted legacy snapshots keep their original text, versioned snapshots must match the built-in', () => {
  const legacy = { enabled: true, template: 'LEGACY_QUEUED_MODE' }
  for (const context of [sessionPromptContent({ promptMode: legacy }), actorSystemContent(participant, { promptMode: legacy })]) {
    assert.equal(context.prompt.split(legacy.template).length - 1, 1)
    assert.ok(!context.prompt.includes(template))
  }
  assert.throws(() => sessionPromptContent({ promptMode: { ...legacy, templateVersion: 'v3' } }), /版本不一致/)
  assert.throws(() => sessionPromptContent({ promptMode: { ...legacy, templateVersion: 'unknown' } }))
})
