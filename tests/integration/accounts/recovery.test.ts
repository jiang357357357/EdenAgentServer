import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EdenDatabase } from '@eden/store'
import { AccountAuthentication, accountKey, recoverSessionOwners, withAccount } from '../../../src/modules/accounts/index.ts'
import { SessionRepository } from '../../../src/modules/sessions/session-repository.ts'

test('historical ownership requires verified saved credentials, and expired or forged metadata cannot claim sessions',async t=>{
 const core=createServer((req,res)=>{
  const id=req.headers.authorization==='Token saved-a'?'1':req.headers.authorization==='Token saved-b'?'2':null
  res.writeHead(id?200:401,{'content-type':'application/json'}).end(JSON.stringify(id?{id}:{error:'expired'}))
 })
 core.listen(0,'127.0.0.1');await once(core,'listening')
 t.after(async()=>{core.closeAllConnections();await new Promise<void>(resolve=>core.close(()=>resolve()))})
 const base=`http://127.0.0.1:${(core.address() as {port:number}).port}`,auth=new AccountAuthentication(base)
 const db=new EdenDatabase(':memory:','mon')
 try{
  const sessions=new SessionRepository(db,'mon')
  const a=sessions.create('old A'),b=sessions.create('old B'),expired=sessions.create('expired'),forged=sessions.create('forged',[],{selfAwakeUserId:'1',userId:'1'})
  for(const [id,token] of [[a.id,'saved-a'],[b.id,'saved-b'],[expired.id,'expired']])db.connection.prepare('INSERT INTO mon_connections VALUES(?,?,?,?)').run(id!,base,token!,Date.now())
  await recoverSessionOwners(db,auth)
  const account=await auth.verify('saved-a')
  assert.equal(account.key,accountKey(base,'1'))
  withAccount(account,()=>{
   assert.deepEqual(sessions.list().map(row=>row.id),[a.id])
   for(const id of [b.id,expired.id,forged.id])assert.throws(()=>sessions.read(id))
  })
  await assert.rejects(auth.verify('expired'))
  await recoverSessionOwners(db,auth)
  assert.equal(sessions.ownership.owner(expired.id),undefined)
 }finally{db.close()}
})
