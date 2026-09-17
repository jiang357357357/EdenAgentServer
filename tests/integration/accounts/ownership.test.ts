import test from 'node:test'
import assert from 'node:assert/strict'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { accountKey, withAccount } from '../../../src/modules/accounts/index.ts'
import { AccountResources } from '../../../src/modules/accounts/resources.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { MemoRepository } from '../../../src/modules/memos/repository.ts'
import { MemoryRepository } from '../../../src/modules/memories/repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'
import { BlobRepository } from '../../../src/modules/blobs/repository.ts'

const account = (userId: string) => ({ key: accountKey('http://127.0.0.1:40011', userId), coreBaseUrl: 'http://127.0.0.1:40011', userId })
test('account scope protects lists, direct reads, independent references, memories and unowned history', () => {
 const db = new EdenDatabase(':memory:', 'mon')
 try {
  const sessions = new SessionRepository(db, 'mon'), jobs = new JobRepository(db), resources = new AccountResources(db)
  const a = account('1'), b = account('2'), scope = {scopeType:'agent_character' as const,scopeKey:'same-character'}
  const old = sessions.create('unassigned')
  const first = withAccount(a, () => sessions.create('A')), second = withAccount(b, () => sessions.create('B'))
  const job = withAccount(a, () => jobs.schedule({kind:'self_awake',sessionId:first.id,dueAt:Date.now()+60000,payload:{},key:'a',causationId:'',depth:0}))
  const memos = new MemoRepository(db), memories = new MemoryRepository(db), wakes = new SelfAwakeRepository(db)
  const memo = withAccount(a, () => memos.create({ title:'A secret', relatedSessionId:first.id } as never))
  const memory = withAccount(a, () => memories.create(scope,'A memory','fact',first.id))
  const run = wakes.begin(job,{}, {})
  withAccount(b, () => {
   assert.deepEqual(sessions.list().map(item=>item.id), [second.id])
   for (const id of [first.id,old.id]) assert.throws(()=>sessions.read(id))
   assert.throws(()=>sessions.rename(first.id,'stolen'))
   assert.throws(()=>sessions.setStatus(first.id,'deleted'))
   assert.throws(()=>sessions.events.list(first.id))
   assert.throws(()=>resources.assert({sessionId:second.id,jobId:job.id}))
   assert.throws(()=>resources.assert({runId:run}))
   assert.deepEqual(jobs.page({}).items,[])
   assert.equal(wakes.list({}).count,0)
   assert.deepEqual(memos.list(),[])
   assert.throws(()=>memos.update(memo.id,{title:'stolen'}))
   assert.deepEqual(memories.search(scope),[])
   assert.throws(()=>memories.read(scope,memory.id))
  })
  assert.equal(sessions.read(first.id).title,'A')
 } finally { db.close() }
})
test('blob deduplication grants ownership only after uploading and event subscribers do not inherit a browser account', () => {
 const db = new EdenDatabase(':memory:', 'mon')
 try {
  const blobs = new BlobRepository(db), sessions = new SessionRepository(db,'mon'), a=account('1'), b=account('2')
  const blob = withAccount(a,()=>blobs.put('a'.repeat(64),'text/plain',5))
  withAccount(b,()=>assert.equal(blobs.read(blob.id),undefined))
  withAccount(b,()=>assert.equal(blobs.put('a'.repeat(64),'text/plain',5).id,blob.id))
  withAccount(b,()=>assert.equal(blobs.read(blob.id)?.byteLength,5))
  sessions.create('background')
  let observed=0
  sessions.events.subscribe(()=> { observed=sessions.list().length })
  withAccount(a,()=>sessions.create('A'))
  assert.equal(observed,2)
 } finally {db.close()}
})
