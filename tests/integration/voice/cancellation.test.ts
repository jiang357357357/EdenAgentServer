import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/index.ts'
import { BlobService, BlobRepository } from '../../../src/modules/blobs/index.ts'
import { SpeechService, SpeechRepository, VoiceConfigRepository } from '../../../src/modules/voice/index.ts'

test('cancelling synthesis aborts a real upstream HTTP request and stores no speech result', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eden-tts-cancel-'))
  const db = new EdenDatabase(':memory:', 'mon')
  let started!: () => void, disconnected!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const closed = new Promise<void>(resolve => { disconnected = resolve })
  const upstream = createServer((_, response) => { response.on('close', disconnected); started() })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const sessions = new SessionRepository(db, 'mon'), session = sessions.create('temporary speech cancellation')
  const repository = new SpeechRepository(db)
  const speech = new SpeechService(repository, sessions, new VoiceConfigRepository(db), new BlobService(root, new BlobRepository(db)), async (_, signal) => {
    const address = upstream.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/tts`, { signal })
    return { bytes: Buffer.from(await response.arrayBuffer()), mime: 'audio/wav', durationMs: null }
  })
  t.after(async () => { await speech.close(); upstream.closeAllConnections(); upstream.close(); db.close(); await rm(root, { recursive: true, force: true }) })
  const requestId = randomUUID()
  const task = speech.synthesize({ requestId, sessionId: session.id, messageId: 'test', segmentGroupId: 'test:0', groupIndex: 0, sequence: 0, text: '临时合成测试', configId: 1, mode: 'all' })
  const rejected = assert.rejects(task, /cancelled/)
  await ready
  const other = sessions.create('another session')
  assert.equal(speech.cancel({ sessionId: other.id, requestId }).cancelled, false)
  assert.equal(speech.cancel({ sessionId: session.id, requestId }).cancelled, true)
  await rejected; await closed
  assert.deepEqual(repository.list(session.id), [])
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM voice_audio_cache').get()!.n, 0)
})
