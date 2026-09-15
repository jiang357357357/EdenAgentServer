import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { UiPreferenceRepository } from '../../../src/modules/ui-preferences/index.ts'
import { uiPreferenceRoutes } from '../../../src/transport/rpc/ui-preferences.routes.ts'

test('scroll preference survives restart, rejects invalid values and stays within its realm', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'eden-ui-pref-'))
  let database = new EdenDatabase(path.join(root, 'mon.db'), 'mon')
  const local = new EdenDatabase(path.join(root, 'local.db'), 'local')
  try {
    const routes = uiPreferenceRoutes(new UiPreferenceRepository(database))
    assert.deepEqual(await routes['ui.preferences.get']({}), { autoScrollEnabled: true })
    await routes['ui.preferences.update']({ autoScrollEnabled: false })
    await assert.rejects(routes['ui.preferences.update']({ autoScrollEnabled: 'false' }))
    database.close()
    database = new EdenDatabase(path.join(root, 'mon.db'), 'mon')
    assert.deepEqual(new UiPreferenceRepository(database).get(), { autoScrollEnabled: false })
    assert.deepEqual(new UiPreferenceRepository(local).get(), { autoScrollEnabled: true })
  } finally { database.close(); local.close(); await rm(root, { recursive: true, force: true }) }
})
