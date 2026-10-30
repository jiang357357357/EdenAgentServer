import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { promptModeConfigSchema } from '@eden/api'
import { withAccount } from '../../../src/modules/accounts/index.ts'
import { PromptModeRepository } from '../../../src/modules/prompt-mode/index.ts'
import { promptModeRoutes } from '../../../src/transport/rpc/prompt-mode.routes.ts'
import { BUILTIN_PROMPT_MODE_TEMPLATE } from '../../../src/model-prompts/prompt-mode-v3.ts'

const account = (key: string) => ({ key, userId: key, coreBaseUrl: 'https://fixture.invalid' })
const defaults = { enabled: false, updatedAt: 0 }

test('config survives restart and remains isolated by account and realm; stale saves cannot overwrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-prompt-mode-'))
  const filename = path.join(root, 'mon.db')
  let database = new EdenDatabase(filename, 'mon')
  const local = new EdenDatabase(path.join(root, 'local.db'), 'local')
  try {
    let routes = promptModeRoutes(new PromptModeRepository(database))
    assert.deepEqual(await withAccount(account('a'), () => routes['prompt.mode.get']({})), defaults)
    const saved = promptModeConfigSchema.parse(await withAccount(account('a'), () => routes['prompt.mode.update']({ enabled: true, expectedUpdatedAt: 0 })))
    assert.ok(saved.updatedAt > 0)
    await assert.rejects(withAccount(account('a'), () => routes['prompt.mode.update']({ enabled: false, expectedUpdatedAt: 0 })), /已变化/)
    await assert.rejects(withAccount(account('a'), () => routes['prompt.mode.update']({ enabled: true, template: '自定义', expectedUpdatedAt: saved.updatedAt })))
    database.close()
    database = new EdenDatabase(filename, 'mon')
    routes = promptModeRoutes(new PromptModeRepository(database))
    assert.deepEqual(await withAccount(account('a'), () => routes['prompt.mode.get']({})), saved)
    assert.deepEqual(await withAccount(account('b'), () => routes['prompt.mode.get']({})), defaults)
    assert.deepEqual(withAccount(account('a'), () => new PromptModeRepository(local).get()), defaults)
    const snapshot = withAccount(account('a'), () => new PromptModeRepository(database).snapshot())
    assert.equal(snapshot.template, BUILTIN_PROMPT_MODE_TEMPLATE)
    assert.equal(snapshot.templateVersion, 'v3')
    const disabled = promptModeConfigSchema.parse(await withAccount(account('a'), () => routes['prompt.mode.update']({ enabled: false, expectedUpdatedAt: saved.updatedAt })))
    assert.equal(disabled.enabled, false)
    assert.ok(!Object.hasOwn(disabled, 'template'))
    assert.deepEqual(withAccount(account('a'), () => new PromptModeRepository(database).snapshot()), { enabled: false, template: '' })
  } finally {
    database.close(); local.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('eden-prompt-mode-'))
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt stored configuration fails explicitly rather than enabling or silently changing the mode', () => {
  const database = new EdenDatabase(':memory:', 'local')
  try {
    const repository = new PromptModeRepository(database)
    repository.update({ enabled: false, expectedUpdatedAt: 0 })
    database.connection.prepare('UPDATE runtime_settings SET value_json=?').run('{broken')
    assert.throws(() => repository.get(), /配置损坏/)
    assert.throws(() => repository.snapshot(), /配置损坏/)
  } finally { database.close() }
})

test('legacy stored custom templates are ignored for new turns and removed by the next explicit save', () => {
  const database = new EdenDatabase(':memory:', 'local')
  try {
    const repository = new PromptModeRepository(database)
    const previous = repository.update({ enabled: false, expectedUpdatedAt: 0 })
    for (const oldTemplate of ['OLD_CUSTOM_TEMPLATE', '']) {
      database.connection.prepare('UPDATE runtime_settings SET value_json=?')
        .run(JSON.stringify({ enabled: true, template: oldTemplate }))
      assert.deepEqual(repository.get(), { enabled: true, updatedAt: previous.updatedAt })
      assert.equal(repository.snapshot().template, BUILTIN_PROMPT_MODE_TEMPLATE)
      assert.equal(repository.snapshot().templateVersion, 'v3')
    }
    repository.update({ enabled: false, expectedUpdatedAt: previous.updatedAt })
    const stored = database.connection.prepare('SELECT value_json FROM runtime_settings').get()!
    assert.deepEqual(JSON.parse(String(stored.value_json)), { enabled: false })
  } finally { database.close() }
})
