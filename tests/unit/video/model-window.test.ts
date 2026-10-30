import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../../src/bootstrap/config.ts'
import { resolveCoreModel } from '../../../src/modules/mon/model-schema.ts'
import { videoFramesSchema, prepareVideoSchema } from '@eden/api'

test('default local and Mon model windows are 256 Ki tokens and explicit provider limits remain valid', () => {
  const local = loadConfig({ EDEN_AGENT_MODEL: 'openai/fixture' })
  assert.equal(local.model!.contextWindow, 262144)
  assert.equal(loadConfig({ EDEN_AGENT_MODEL: 'openai/fixture', EDEN_AGENT_CONTEXT_WINDOW: '65536' }).model!.contextWindow, 65536)
  const entity = { id: 1, vendor: 'fixture', ai_model: 'fixture', status: 'active', api_key: 'test-only', api_endpoint: 'https://example.test/v1' }
  assert.equal(resolveCoreModel(entity).model.contextWindow, 262144)
  assert.equal(resolveCoreModel({ ...entity, default_params: { context_window: 65536 } }).model.contextWindow, 65536)
})

test('video public input contracts bound output frames and reject ambiguous sources', () => {
  assert.equal(videoFramesSchema.safeParse({ job_id: 'A'.repeat(32), frame_ids: Array.from({ length: 9 }, (_, n) => `f_${String(n).padStart(6, '0')}`), max_frames: 9 }).success, false)
  assert.equal(prepareVideoSchema.safeParse({ source: { path: 'movie.mp4', youtubeUrl: 'https://youtu.be/abcdefghijk' } }).success, false)
})
