import { test } from 'node:test'
import { runToolConnectionScenario } from './tool-connection-fixture.mjs'

test('successful real account refresh preserves tool events and the browser connection', { timeout: 90_000 }, async () => {
  await runToolConnectionScenario()
})
