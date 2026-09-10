import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { modelContextUsage } from '@eden/api'
import { SessionRepository } from '../src/modules/sessions/session-repository.ts'

test('usage counts cache separately and replaces rather than accumulates requests', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const repository = new SessionRepository(db, 'mon'), session=repository.create('context')
    assert.equal(repository.read(session.id).contextTokens,undefined)
    repository.events.append(session.id,null,'model.response',{usage:{input:100,cacheRead:900,cacheWrite:0,output:50}})
    assert.equal(repository.read(session.id).contextTokens,1050)
    const restored = new SessionRepository(db,'mon').read(session.id)
    assert.equal(restored.contextTokens,1050)
    assert.equal((restored.tokenBreakdown as {cacheHitRate:number}).cacheHitRate,.9)
    repository.events.append(session.id,null,'model.response',{usage:{input:20,cacheRead:100,cacheWrite:10,output:5}})
    assert.equal(repository.read(session.id).contextTokens,135)
  } finally { db.connection.close() }
})
test('missing usage and unknown categories are not fabricated as zero', () => {
  assert.equal(modelContextUsage({usage:null}),undefined)
  assert.equal(modelContextUsage({usage:{input:-1,output:0}}),undefined)
  const result = modelContextUsage({usage:{input:100,output:10}})!
  assert.equal(result.contextTokens,110)
  assert.equal(result.tokenBreakdown.cacheHitRate,undefined)
  assert.equal('character' in result.tokenBreakdown,false)
})
test('a failed provider response without usage does not erase the last known usage on reload', () => {
  const db = new EdenDatabase(':memory:', 'mon')
  try {
    const repository=new SessionRepository(db,'mon'),session=repository.create('context')
    repository.events.append(session.id,null,'model.response',{usage:{input:100,output:20,cacheRead:0,cacheWrite:0}})
    repository.events.append(session.id,null,'model.response',{usage:null,stopReason:'error'})
    assert.equal(repository.read(session.id).contextTokens,120)
  }finally{db.connection.close()}
})
