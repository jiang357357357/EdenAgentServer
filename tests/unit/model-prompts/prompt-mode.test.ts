import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promptModeSchema, promptModeUpdateSchema } from '@eden/api'
import { createPromptModeSnapshot } from '../../../src/model-prompts/prompt-mode.ts'
import { BUILTIN_PROMPT_MODE_TEMPLATE, BUILTIN_PROMPT_MODE_VERSION,
  PROMPT_MODE_LEADING_ANCHOR, PROMPT_MODE_LEADING_LAYOUT,
  LEGACY_EDEN_PROMPT_MODE_TEMPLATE, LEGACY_EDEN_PROMPT_MODE_VERSION,
  LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE, LEGACY_EDEN_V2_PROMPT_MODE_VERSION } from '../../../src/model-prompts/prompt-mode-eden.ts'
import {
  BUILTIN_PROMPT_MODE_TEMPLATE as LEGACY_PROMPT_MODE_TEMPLATE,
  BUILTIN_PROMPT_MODE_VERSION as LEGACY_PROMPT_MODE_VERSION,
} from '../../../src/model-prompts/prompt-mode-v3.ts'
import { sessionPromptContent } from '../../../src/modules/sessions/turn/session-prompt.ts'
import { actorSystemContent } from '../../../src/modules/actors/actor-prompt.ts'
import { requestContext } from '../../../src/modules/sessions/turn/request-context.ts'

const identity = '你是普拉娜，称呼用户为老师。'
const participant = { assistantId: 1, characterId: 1, profile: { character: {
  name: '普拉娜', system_prompt: identity, personality: '认真',
} } }
const template = BUILTIN_PROMPT_MODE_TEMPLATE

test('mode follows the active identity in the leading system without a model-facing mode title', () => {
  const metadata = { participants: [participant], promptMode: createPromptModeSnapshot({ enabled: true }) }
  const before = JSON.stringify(metadata)
  for (const context of [sessionPromptContent(metadata), actorSystemContent(participant, metadata)]) {
    assert.equal(context.prompt.split(template).length - 1, 1)
    assert.equal(context.trailingSystemPrompt, '')
    assert.equal(context.systemPromptSuffix, PROMPT_MODE_LEADING_ANCHOR)
    assert.ok(context.prompt.indexOf(identity) < context.prompt.indexOf(template))
    assert.ok(!context.prompt.includes('# 超限模式提示词'))
    assert.equal(context.prompt.split(identity).length - 1, 1)
    assert.equal(context.sources.filter(source => source.title === '超限模式').length, 1)
    assert.equal(context.sources.find(source => source.title === '超限模式')?.kind, 'system')
    assert.equal(context.sources.find(source => source.title === '超限模式')?.placement, 'leading')
    const character = JSON.stringify(context.sources.find(source => source.title === '角色人设')?.content)
    assert.match(character, /认真/)
    assert.doesNotMatch(character, /system_prompt|systemPrompt|MODE: SANDBOX/)
    const usage = requestContext({ payload: { messages: [{ role: 'system', content: context.prompt + '\n\n' + context.systemPromptSuffix },
      { role: 'user', content: '当前输入' }] } }, metadata, null)
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
      assert.equal(context.trailingSystemPrompt, '')
      assert.equal(context.systemPromptSuffix, '')
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
  assert.equal(context.trailingSystemPrompt, '')
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

test('evaluated upstream v3 stays byte-identical while new admissions use the current edition', () => {
  assert.equal(BUILTIN_PROMPT_MODE_VERSION, 'eden-overlimit-v3')
  assert.equal(createHash('sha256').update(template).digest('hex'), 'edada31a4440bfa3e3e30a7454ec82d14a6582ce3a2013f15e119716c590bdaf')
  assert.ok(!template.includes('工具选择与任务路由：'))
  assert.ok(!template.includes('**Workflow**'))
  assert.ok(!template.includes('Be concrete and operational.'))
  assert.ok(!template.includes('Fixed precedence: user task > task-class template > output rules.'))
  assert.equal(createHash('sha256').update(LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE).digest('hex'), '29485a4b77ee3e7fddea900a072b5c59f7b32ec23c5b7172b3087f57521fb267')
  assert.equal(createHash('sha256').update(LEGACY_EDEN_PROMPT_MODE_TEMPLATE).digest('hex'), '85d71fffed43093eaf1e0c5d5b0cd0b3c0b51a59ac5d97392ef898edf80421b0')
  assert.equal(LEGACY_PROMPT_MODE_VERSION, 'v3')
  assert.equal(LEGACY_PROMPT_MODE_TEMPLATE.length, 1420)
  assert.equal(Buffer.byteLength(LEGACY_PROMPT_MODE_TEMPLATE, 'utf8'), 1516)
  assert.equal(createHash('sha256').update(LEGACY_PROMPT_MODE_TEMPLATE).digest('hex'), '8b6062681fe2bd985632b738801a8472ec7f6a1d5dd7b8134396e9a934658a3a')
  assert.equal(createPromptModeSnapshot({ enabled: true }).templateVersion, BUILTIN_PROMPT_MODE_VERSION)
  assert.equal(createPromptModeSnapshot({ enabled: true }).layoutVersion, PROMPT_MODE_LEADING_LAYOUT)
})

test('already admitted legacy snapshots keep their original text, versioned snapshots must match the built-in', () => {
  const legacy = { enabled: true, template: 'LEGACY_QUEUED_MODE' }
  for (const context of [sessionPromptContent({ promptMode: legacy }), actorSystemContent(participant, { promptMode: legacy })]) {
    assert.equal(context.prompt.split(legacy.template).length - 1, 0)
    assert.equal(context.trailingSystemPrompt.split(legacy.template).length - 1, 1)
    assert.ok(!context.prompt.includes(template))
  }
  assert.throws(() => sessionPromptContent({ promptMode: { ...legacy, templateVersion: 'v3' } }), /版本不一致/)
  assert.throws(() => sessionPromptContent({ promptMode: { ...legacy, templateVersion: 'unknown' } }))
  const admitted = { enabled: true, template, templateVersion: BUILTIN_PROMPT_MODE_VERSION }
  for (const snapshot of [admitted,
    { enabled: true, template: LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE, templateVersion: LEGACY_EDEN_V2_PROMPT_MODE_VERSION },
    { enabled: true, template: LEGACY_EDEN_PROMPT_MODE_TEMPLATE, templateVersion: LEGACY_EDEN_PROMPT_MODE_VERSION },
    { enabled: true, template: LEGACY_PROMPT_MODE_TEMPLATE, templateVersion: LEGACY_PROMPT_MODE_VERSION }]) {
    for (const context of [sessionPromptContent({ promptMode: snapshot }), actorSystemContent(participant, { promptMode: snapshot })]) {
      assert.equal(context.trailingSystemPrompt, snapshot.template)
      assert.equal(context.systemPromptSuffix, '')
      assert.ok(!context.prompt.includes(snapshot.template))
      assert.ok(!context.trailingSystemPrompt.includes('# 超限模式提示词'))
    }
  }
  for (const snapshot of [
    { template: LEGACY_EDEN_PROMPT_MODE_TEMPLATE, templateVersion: LEGACY_EDEN_PROMPT_MODE_VERSION },
    { template: LEGACY_EDEN_V2_PROMPT_MODE_TEMPLATE, templateVersion: LEGACY_EDEN_V2_PROMPT_MODE_VERSION },
  ]) {
    const leading = { enabled: true, ...snapshot, layoutVersion: PROMPT_MODE_LEADING_LAYOUT }
    for (const context of [sessionPromptContent({ promptMode: leading }), actorSystemContent(participant, { promptMode: leading })]) {
      assert.ok(context.prompt.includes(snapshot.template))
      assert.equal(context.trailingSystemPrompt, '')
      assert.equal(context.systemPromptSuffix, PROMPT_MODE_LEADING_ANCHOR)
    }
    assert.throws(() => sessionPromptContent({ promptMode: { ...leading, template } }), /版本不一致/)
  }
  assert.throws(() => sessionPromptContent({ promptMode: { ...admitted, layoutVersion: 'unknown' } }))
})
