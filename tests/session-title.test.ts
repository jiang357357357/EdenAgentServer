import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { recordedModel } from '@eden/runtime-pi/testing'
import { SessionRepository, SessionTitleService, fallbackSessionTitle, generatedSessionTitle } from '../src/modules/sessions/index.ts'

async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for session title')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('first user prompt gets an immediate fallback and an asynchronous model title', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local')
  const model = await recordedModel([{ text: '会话标题自动生成' }])
  const titles = new SessionTitleService(repository, () => model.config)
  try {
    const session = repository.create('')
    titles.schedule(session.id, randomUUID(), '请根据当前会话内容自动生成一个合适的标题')
    assert.equal(repository.read(session.id).title, '请根据当前会话内容自动生成一个合适的标题')
    assert.equal(repository.read(session.id).titleSource, 'fallback')

    await eventually(() => repository.read(session.id).titleSource === 'generated')
    assert.equal(repository.read(session.id).title, '会话标题自动生成')
    assert.equal(model.requests.length, 1)
    assert.deepEqual(repository.events.list(session.id, '0', 100).filter(event => event.kind === 'session.title_updated')
      .map(event => event.payload), [
        { title: '请根据当前会话内容自动生成一个合适的标题', titleSource: 'fallback' },
        { title: '会话标题自动生成', titleSource: 'generated' },
      ])
  } finally { await titles.close(); await model.close(); database.close() }
})

test('manual rename cannot be overwritten by a late model title', async () => {
  const database = new EdenDatabase(':memory:', 'local')
  const repository = new SessionRepository(database, 'local')
  const model = await recordedModel([{ wait: true }])
  const titles = new SessionTitleService(repository, () => model.config)
  try {
    const session = repository.create('')
    titles.schedule(session.id, randomUUID(), '等待中的标题请求')
    await eventually(() => model.requests.length === 1)
    repository.rename(session.id, '老师指定的标题')
    titles.cancel(session.id)
    await eventually(() => repository.read(session.id).titleSource === 'user')
    assert.equal(repository.read(session.id).title, '老师指定的标题')
  } finally { await titles.close(); await model.close(); database.close() }
})

test('title normalization removes formatting and bounds displayed text', () => {
  assert.equal(generatedSessionTitle('  标题： “修复会话标题”  '), '修复会话标题')
  assert.equal(fallbackSessionTitle('\u001b[31m第一条消息\u001b[0m\n继续'), '第一条消息 继续')
  assert.equal(Array.from(fallbackSessionTitle('字'.repeat(100))).length, 32)
})
