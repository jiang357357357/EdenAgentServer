import assert from 'node:assert/strict'
import test from 'node:test'
import { InputArbiter } from '../../../src/modules/desktop/input-arbiter.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test('two worlds serialize physical input and status does not expose another owner', async () => {
  const arbiter = new InputArbiter(() => {})
  let finish!: () => void, secondStarted = false
  const first = arbiter.run({ owner: 'mon', session: 'a', id: '1' }, 'type', 'Private mon title', true,
    () => new Promise<void>(resolve => { finish = resolve }))
  await tick()
  const second = arbiter.run({ owner: 'local', session: 'b', id: '2' }, 'type', 'Local title', true, async () => { secondStarted = true })
  await tick()
  assert.equal(secondStarted, false)
  assert.equal(arbiter.status('local', true).operations.length, 1)
  assert.equal(JSON.stringify(arbiter.status('local', true)).includes('Private mon'), false)
  finish(); await Promise.all([first, second]); assert.equal(secondStarted, true)
})
test('user takeover cancels active and queued input; resume does not replay cancelled work', async () => {
  const arbiter = new InputArbiter(() => {})
  const first = arbiter.run({ owner: 'a', session: 'a', id: '1' }, 'type', '', true,
    signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  const rejectedFirst = assert.rejects(first, /暂停/)
  await tick()
  let replayed = false
  const second = arbiter.run({ owner: 'b', session: 'b', id: '2' }, 'type', '', true, async () => { replayed = true })
  const rejectedSecond = assert.rejects(second, /暂停/)
  arbiter.physicalInput(false)
  await Promise.all([rejectedFirst, rejectedSecond])
  assert.equal(arbiter.paused, true); assert.equal(replayed, false)
  arbiter.control('resume'); await tick(); assert.equal(replayed, false)
  await arbiter.run({ owner: 'b', session: 'b', id: '3' }, 'type', '', true, async () => { replayed = true })
  assert.equal(replayed, true)
})
test('cancellation retains the desktop slot until native execution actually settles', async () => {
  const arbiter = new InputArbiter(() => {})
  let finish!: () => void
  const first = arbiter.run({ owner: 'a', session: 'a', id: '1' }, 'type', '', true,
    () => new Promise<void>(resolve => { finish = resolve }))
  const cancelled = assert.rejects(first, /取消/)
  await tick(); arbiter.cancel('a')
  let next = false
  const second = arbiter.run({ owner: 'b', session: 'b', id: '2' }, 'type', '', false, async () => { next = true })
  await tick(); assert.equal(next, false)
  finish(); await cancelled; await second; assert.equal(next, true)
})

test('background work pauses when the user interacts with its window, while other windows remain usable', async () => {
  const arbiter = new InputArbiter(() => {})
  const work = arbiter.run({ owner: 'a', session: 'a', id: '1' }, 'type', '', false,
    signal => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), '42')
  const cancelled = assert.rejects(work, /暂停/)
  await tick(); arbiter.physicalInput(false, '99'); assert.equal(arbiter.paused, false)
  arbiter.physicalInput(false, '42'); await cancelled; assert.equal(arbiter.paused, true)
})
