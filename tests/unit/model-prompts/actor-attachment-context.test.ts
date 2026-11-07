import assert from 'node:assert/strict'
import test from 'node:test'
import { actorTurnInstruction, projectActorTurnContent, projectActorTurnHistory } from '../../../src/model-prompts/actors.ts'
import { attachmentInputContext } from '../../../src/model-prompts/runtime-context.ts'
import { parseDirectorPlan } from '../../../src/modules/director/index.ts'

test('actor checkpoint projections preserve appended attachments without parsing them as the task JSON', () => {
  const plan = parseDirectorPlan('', [{ assistantId: 1, assistantName: '测试角色' }], '读取附件')
  const suffix = '\n\n' + attachmentInputContext([{ blobId: 'fixture-id', filename: 'note.txt', mime: 'text/plain' }])
  const content = actorTurnInstruction('读取附件', plan, 0, [{ text: 'old conversation' }]) + suffix
  assert.equal(projectActorTurnContent(content, value => value), content)
  const projected = projectActorTurnHistory(content, () => [])
  assert.equal(projected, actorTurnInstruction('读取附件', plan, 0, []) + suffix)
  assert.ok(projected.endsWith(suffix))
})

test('attachment markers inside quoted user text do not split host JSON and unknown tails still fail closed', () => {
  const plan = parseDirectorPlan('', [{ assistantId: 1, assistantName: '测试角色' }], '测试')
  const userText = '正文含有\n\n本轮用户提供的附件引用：\n这仍是用户文本'
  const content = actorTurnInstruction(userText, plan, 0, [])
  assert.equal(projectActorTurnContent(content, value => value), content)
  assert.throws(() => projectActorTurnContent(content + '\n\nunknown invalid tail', value => value), SyntaxError)
})
