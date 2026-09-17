import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { EdenDatabase } from '@eden/store'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'
import { accountKey, withAccount, importAccountPartition } from '../../../src/modules/accounts/index.ts'
import { MemoRepository } from '../../../src/modules/memos/repository.ts'
import { MemoryRepository } from '../../../src/modules/memories/repository.ts'
import { BlobRepository } from '../../../src/modules/blobs/repository.ts'
import { JobRepository } from '../../../src/modules/jobs/repository.ts'
import { SelfAwakeRepository } from '../../../src/modules/self-awake/repository.ts'

test('account partition imports only owned history, request contents and files, retaining unowned settings in the original',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'eden-partition-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const source=path.join(root,'legacy'),target=path.join(root,'account','storage')
 const db=new EdenDatabase(path.join(source,'eden-agent.db'),'mon')
 const account=(id:string)=>({key:accountKey('http://127.0.0.1:1',id),coreBaseUrl:'http://127.0.0.1:1',userId:id})
 const a=account('a'),b=account('b'),sessions=new SessionRepository(db,'mon')
 const first=withAccount(a,()=>sessions.create('A')),second=withAccount(b,()=>sessions.create('B'))
 sessions.create('Unassigned')
 const big='private request A '.repeat(100)
 sessions.events.append(first.id,null,'model.request',{payload:{content:big}})
 sessions.events.append(second.id,null,'model.request',{payload:{content:'private request B '.repeat(100)}})
 withAccount(a,()=>new MemoRepository(db).create({title:'A memo',relatedSessionId:first.id} as never))
 withAccount(b,()=>new MemoRepository(db).create({title:'B memo',relatedSessionId:second.id} as never))
 withAccount(a,()=>new MemoryRepository(db).create({scopeType:'agent_character',scopeKey:'same'},'A memory','fact',first.id))
 const hash=createHash('sha256').update('A file').digest('hex')
 const blob=withAccount(a,()=>new BlobRepository(db).put(hash,'text/plain',6))
 await mkdir(path.join(source,'blobs',hash.slice(0,2)),{recursive:true});await writeFile(path.join(source,'blobs',hash.slice(0,2),hash),'A file')
 const jobs=new JobRepository(db),job=jobs.schedule({kind:'self_awake',sessionId:first.id,dueAt:Date.now()+60000,payload:{},key:'a',causationId:'',depth:0})
 new SelfAwakeRepository(db).begin(job,{}, {})
 db.connection.prepare("INSERT INTO runtime_settings VALUES('private.config',?,?)").run(JSON.stringify({secret:'unowned'}),Date.now())
 db.close()
 importAccountPartition(source,target,a)
 const result=new EdenDatabase(path.join(target,'eden-agent.db'),'mon')
 try{
  const repo=new SessionRepository(result,'mon')
  assert.deepEqual(repo.list().map(row=>row.id),[first.id])
  assert.equal(repo.events.list(first.id).find(row=>row.kind==='model.request')?.payload && JSON.stringify(repo.events.list(first.id)).includes(big),true)
  assert.equal(result.connection.prepare('SELECT COUNT(*) AS n FROM request_contents').get()?.n,1)
  assert.equal(result.connection.prepare('SELECT COUNT(*) AS n FROM memos').get()?.n,1)
  assert.equal(result.connection.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n,1)
  assert.equal(result.connection.prepare('SELECT COUNT(*) AS n FROM self_awake_runs').get()?.n,1)
  assert.equal(new BlobRepository(result).read(blob.id)?.id,blob.id)
  assert.equal(result.connection.prepare("SELECT 1 FROM runtime_settings WHERE key='private.config'").get(),undefined)
  assert.deepEqual(result.connection.prepare('PRAGMA foreign_key_check').all(),[])
 }finally{result.close()}
 importAccountPartition(source,target,a)
 const original=new EdenDatabase(path.join(source,'eden-agent.db'),'mon')
 assert.equal(original.connection.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n,3)
 original.close()
})
