import assert from 'node:assert/strict'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { SkillRepository, builtinSkillSnapshots, createSkillSnapshot } from '../../../src/modules/skills/index.ts'
import { capabilityFixture } from './fixture.ts'

test('bundled guides use normal skill resolution without duplicate names or shared world enablement', t => {
  const mon = new EdenDatabase(':memory:', 'mon'), local = new EdenDatabase(':memory:', 'local')
  t.after(() => { mon.close(); local.close() })
  const first = new SkillRepository(mon, undefined, undefined, undefined, undefined, undefined, builtinSkillSnapshots)
  const second = new SkillRepository(local, undefined, undefined, undefined, undefined, undefined, builtinSkillSnapshots)
  assert.equal(first.list(false).length, 4)
  assert.ok(first.list(false).every(skill => skill.content === null && skill.codeTools?.length === 0))
  first.enable('eden-memory', false)
  assert.equal(first.read('eden-memory').enabled, false)
  assert.equal(second.read('eden-memory').enabled, true)
  const replacement = createSkillSnapshot({ 'SKILL.md': Buffer.from('---\nname: eden-reminders\ndescription: 私有提醒流程\n---\n自定义正文').toString('base64') }, 'eden-reminders')
  const preview = first.preview(replacement, { type: 'generated', uri: '', ref: '', subpath: '' }, 'user')
  first.install(preview.previewID)
  assert.equal(first.list(false).filter(skill => skill.name === 'eden-reminders').length, 1)
  assert.match(first.read('eden-reminders').content!, /自定义正文/)
  assert.doesNotMatch(second.read('eden-reminders').content!, /自定义正文/)
})

test('reading or re-reading instructions never loads or restores tool interfaces', async t => {
  const f = await capabilityFixture(); t.after(() => f.close()); f.install()
  const first = f.capabilities().loadSkill('echo-skill')
  assert.equal(first.tools[0]!.loaded, false)
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.exposeEcho()
  f.capabilities().unloadTools(['skill:echo-skill:echo_skill'])
  f.capabilities().loadSkill('echo-skill')
  assert.ok(!f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
  f.exposeEcho(); f.capabilities().unloadSkill('echo-skill')
  assert.ok(f.capabilities().tools().some(tool => tool.name === 'echo_skill'))
})
