import assert from 'node:assert/strict'
import test from 'node:test'
import { SynthesisJobs } from '../../../src/modules/voice/synthesis-jobs.ts'

test('cancelling one shared requester preserves the other, last cancellation aborts upstream', async () => {
  const jobs = new SynthesisJobs<string>()
  let upstream: AbortSignal | undefined, starts = 0
  const execute = (signal: AbortSignal) => { starts++; upstream = signal; return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }
  const first = jobs.run('same', 'session:first', execute), second = jobs.run('same', 'session:second', execute)
  const rejectedFirst = assert.rejects(first, /cancelled/), rejectedSecond = assert.rejects(second, /cancelled/)
  await Promise.resolve()
  assert.equal(starts, 1)
  assert.equal(jobs.cancel('other-session:first'), false)
  jobs.cancel('session:first'); await rejectedFirst
  assert.equal(upstream!.aborted, false)
  jobs.cancel('session:second'); await rejectedSecond
  assert.equal(upstream!.aborted, true)
  assert.equal(await jobs.run('same', 'session:retry', async () => 'retried'), 'retried')
  await jobs.close()
})

test('third request waits in a bounded queue, sessions take turns and queued cancellation never executes', async () => {
  const jobs = new SynthesisJobs<string>({ concurrency: 1, pending: 4 }), starts: string[] = []
  const finishes = new Map<string, (value: string) => void>()
  const work = (name: string) => jobs.run(name, `${name.startsWith('a') ? 'session-a' : 'session-b'}:${name}`, () => {
    starts.push(name); return new Promise<string>(resolve => finishes.set(name, resolve))
  })
  const first = work('a1'), second = work('a2'), third = work('b1'), cancelled = work('b2')
  const cancelledResult = assert.rejects(cancelled, /cancelled/)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(starts, ['a1']); jobs.cancel('session-b:b2'); await cancelledResult
  finishes.get('a1')!('a1'); await first
  await new Promise<void>(resolve => setImmediate(resolve)); assert.deepEqual(starts, ['a1', 'b1'])
  finishes.get('b1')!('b1'); await third
  await new Promise<void>(resolve => setImmediate(resolve)); finishes.get('a2')!('a2'); await second
  assert.deepEqual(starts, ['a1', 'b1', 'a2']); await jobs.close()
})

test('queue and execution deadlines terminate waiting even when a provider ignores cancellation', async () => {
  const jobs = new SynthesisJobs<string>({ concurrency: 1, pending: 1, queueTimeoutMs: 20, executionTimeoutMs: 60 })
  const never = () => new Promise<string>(() => {})
  const active = jobs.run('active', 'one:active', never), queued = jobs.run('queued', 'two:queued', never)
  const activeResult = assert.rejects(active, /合成超时/), queuedResult = assert.rejects(queued, /排队超时/)
  await assert.rejects(jobs.run('overflow', 'three:overflow', never), /队列已满/)
  await Promise.all([activeResult, queuedResult])
  assert.equal(await jobs.run('later', 'four:later', async () => 'recovered'), 'recovered')
  const pending = jobs.run('close', 'five:close', never), rejected = assert.rejects(pending, /cancelled/)
  await jobs.close(); await rejected
})

test('late completion of cancelled work cannot remove a replacement job', async () => {
  const jobs = new SynthesisJobs<string>()
  let finishOld!: (value: string) => void, finishNew!: (value: string) => void
  const old = jobs.run('same', 'old', () => new Promise(resolve => { finishOld = resolve }))
  const rejected = assert.rejects(old, /cancelled/)
  await Promise.resolve(); jobs.cancel('old'); await rejected
  const next = jobs.run('same', 'new', () => new Promise(resolve => { finishNew = resolve }))
  await Promise.resolve(); finishOld('obsolete'); await Promise.resolve()
  const shared = jobs.run('same', 'shared', async () => { throw new Error('must reuse new job') })
  finishNew('new audio')
  assert.deepEqual(await Promise.all([next, shared]), ['new audio', 'new audio'])
  await jobs.close()
})
