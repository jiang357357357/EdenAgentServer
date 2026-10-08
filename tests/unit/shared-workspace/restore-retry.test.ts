import assert from 'node:assert/strict'
import test from 'node:test'
import { SharedRestoreRetry } from '../../../src/modules/shared-workspace/restore-retry.ts'

test('restoration backoff doubles up to five minutes and warns again only for a changed or recovered fault', () => {
  let now = 1000
  const retry = new SharedRestoreRetry(() => now)
  assert.equal(retry.delay(), undefined)
  assert.equal(retry.failed('registry', 'broken JSON'), true)
  assert.equal(retry.canAttempt('registry'), false)
  assert.equal(retry.delay('registry'), 30_000)
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    now += retry.delay('registry')!
    assert.equal(retry.canAttempt('registry'), true)
    assert.equal(retry.failed('registry', 'broken JSON'), false)
    assert.equal(retry.delay('registry'), delay)
  }
  assert.equal(retry.failed('registry', 'another account'), true)
  retry.succeeded('registry')
  assert.equal(retry.delay(), undefined)
  assert.equal(retry.failed('registry', 'another account'), true)
  assert.equal(retry.delay(), 30_000)
})

test('independent folder retry schedules remain separate from the registry delay', () => {
  let now = 1000
  const retry = new SharedRestoreRetry(() => now)
  retry.failed('folder:a', 'missing')
  now += 5000
  retry.failed('registry', 'broken')
  assert.equal(retry.delay(), 25_000)
  assert.equal(retry.delay('registry'), 30_000)
  assert.equal(retry.canAttempt('folder:b'), true)
  retry.succeeded('folder:a')
  assert.equal(retry.delay(), 30_000)
})
