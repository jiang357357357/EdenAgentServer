import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { ReconnectLoop } from '../../../tui/reconnect-loop.ts'

test('reconnect uses increasing delays and a strict attempt limit without idle polling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0, exhausted = 0
  const progress: number[] = []
  const loop = new ReconnectLoop({ attempt: async () => { attempts++; return true },
    progress: attempt => { progress.push(attempt) }, exhausted: () => { exhausted++ } }, [5, 10, 20])
  context.mock.timers.tick(100); await setImmediate()
  assert.equal(attempts, 0)
  loop.start(); loop.start()
  for (const delay of [5, 10, 20]) {
    context.mock.timers.tick(delay - 1); await setImmediate()
    const before: number = attempts
    context.mock.timers.tick(1); await setImmediate()
    assert.equal(attempts, before + 1)
  }
  context.mock.timers.tick(1000); await setImmediate()
  assert.equal(attempts, 3)
  assert.equal(exhausted, 1)
  assert.deepEqual(progress, [1, 2, 3])
})

test('success and cancellation stop scheduling, including an in-flight failed attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0, resolve: (retry: boolean) => void = () => {}
  const loop = new ReconnectLoop({ attempt: () => { attempts++; return new Promise(done => { resolve = done }) },
    progress: () => {}, exhausted: () => { throw new Error('must not exhaust') } }, [1, 1])
  loop.start(); context.mock.timers.tick(1); await setImmediate()
  loop.stop(); resolve(true); await setImmediate()
  context.mock.timers.tick(100); await setImmediate()
  assert.equal(attempts, 1)
  loop.start(); context.mock.timers.tick(1); await setImmediate()
  resolve(false); await setImmediate()
  context.mock.timers.tick(100); await setImmediate()
  assert.equal(attempts, 2)
})
