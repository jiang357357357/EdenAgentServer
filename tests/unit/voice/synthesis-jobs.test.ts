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
