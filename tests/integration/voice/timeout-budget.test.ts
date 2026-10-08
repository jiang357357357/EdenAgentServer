import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { OperationFailure } from '@eden/api'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { BlobRepository, BlobService } from '../../../src/modules/blobs/index.ts'
import { SpeechRepository, SpeechService, VoiceConfigRepository } from '../../../src/modules/voice/index.ts'

test('HTTP execution timeout stops automatic speech across database restart, with explicit manual recovery', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-speech-timeout-'))
  let requests = 0, healthy = false
  const upstream = createServer((_request, response) => {
    requests++
    if (healthy) response.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from('fixture audio'))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const filename = path.join(root, 'fixture.sqlite')
  let database = new EdenDatabase(filename, 'mon')
  const makeSpeech = () => {
    const sessions = new SessionRepository(database, 'mon')
    return { sessions, speech: new SpeechService(new SpeechRepository(database), sessions, new VoiceConfigRepository(database),
      new BlobService(path.join(root, 'blobs'), new BlobRepository(database)), async (_input, signal) => {
        const response = await fetch(`http://127.0.0.1:${(upstream.address() as { port: number }).port}/tts`, { signal })
        return { bytes: Buffer.from(await response.arrayBuffer()), mime: 'audio/wav', durationMs: null }
      }, { executionTimeoutMs: 300 }) }
  }
  let fixture = makeSpeech()
  t.after(async () => { await fixture.speech.close(); database.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const session = fixture.sessions.create('timeout fixture')
  const input = { sessionId: session.id, messageId: 'one', segmentGroupId: 'first', groupIndex: 0, sequence: 0,
    text: 'timeout test', configId: 1, mode: 'all', intent: 'auto' }
  await assert.rejects(fixture.speech.synthesize(input), error => error instanceof OperationFailure &&
    error.details.kind === 'speech_timeout' && error.details.outcome === 'unknown' && !error.details.retryable)
  assert.equal(requests, 1)
  assert.equal(database.connection.prepare('SELECT attempts FROM voice_synthesis_failures').get()!.attempts, 4)
  await fixture.speech.close(); database.close()
  database = new EdenDatabase(filename, 'mon'); fixture = makeSpeech()
  for (let revision = 0; revision < 12; revision++) {
    await assert.rejects(fixture.speech.synthesize({ ...input, segmentGroupId: `rewrite:${revision}` }),
      error => error instanceof OperationFailure && error.details.kind === 'speech_paused')
  }
  assert.equal(requests, 1)
  healthy = true
  const result = await fixture.speech.synthesize({ ...input, intent: 'manual' })
  assert.equal(result.success, true); assert.equal(requests, 2)
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS n FROM voice_synthesis_failures').get()!.n, 0)
  assert.equal(fixture.sessions.events.list(session.id).filter(event => event.kind === 'voice.retry_requested').length, 1)
})
