import assert from 'node:assert/strict'
import test from 'node:test'
import { EdenDatabase } from '@eden/store'
import { pluginUiModuleSchema } from '@eden/api'
import { ExtensionStateRepository } from '../../../src/modules/plugin-ui/extension-state.ts'
import { withAccount } from '../../../src/modules/accounts/index.ts'

const module = (configuration = {}) => pluginUiModuleSchema.parse({ pluginId:'state-test',pluginName:'State',componentId:'main',
  revision:'a'.repeat(64),sha256:'b'.repeat(64),document:{schemaVersion:1,type:'module',apiVersion:2,entry:'extension.js',views:[],contributes:{configuration}} })
const base = {scope:'global',namespace:'storage'}

test('deleted keys release quota while tombstone revisions still reject stale writes', () => {
  const db = new EdenDatabase(':memory:','local'), state = new ExtensionStateRepository(db), descriptor = module()
  try {
    for (let i=0;i<600;i++) {
      state.access(descriptor,{...base,key:'key-'+i,value:1},null)
      state.access(descriptor,{...base,key:'key-'+i,remove:true},null)
    }
    assert.deepEqual(state.access(descriptor,{...base,key:'new-key',value:1},null),{value:1,revision:1})
    assert.throws(()=>state.access(descriptor,{...base,key:'key-0',value:2,expectedRevision:1},null),/changed/)
    for(let i=0;i<511;i++) state.access(descriptor,{...base,key:'live-'+i,value:1},null)
    assert.throws(()=>state.access(descriptor,{...base,key:'overflow',value:1},null),/quota/)
    assert.throws(()=>state.access(descriptor,{...base,key:'key-0',value:1},null),/quota/)
    state.access(descriptor,{...base,key:'new-key',remove:true},null)
    assert.equal(state.access(descriptor,{...base,key:'key-0',value:2,expectedRevision:2},null).revision,3)
  } finally {db.close()}
})

test('changed setting types and enums return safe defaults, retain revisions and preserve rollback data', () => {
  const db = new EdenDatabase(':memory:','local'), state = new ExtensionStateRepository(db)
  const old = module({enabled:{type:'string',title:'Enabled',default:'true'}})
  const current = module({enabled:{type:'boolean',title:'Enabled',default:false}})
  const request = {scope:'global',namespace:'configuration',key:'enabled'}
  try {
    state.access(old,{...request,value:'false'},null)
    assert.deepEqual(state.access(current,request,null),{value:false,revision:1})
    assert.deepEqual(state.access(old,request,null),{value:'false',revision:1})
    const changedEnum = module({enabled:{type:'string',title:'Enabled',default:'auto',enum:['auto','on']}})
    assert.equal(state.access(changedEnum,request,null).value,'auto')
    state.access(current,{...request,value:true,expectedRevision:1},null)
    assert.deepEqual(state.access(current,request,null),{value:true,revision:2})
    assert.equal(state.configurationRevision('state-test','main'),2)
    withAccount({key:'another',userId:'another',coreBaseUrl:'https://fixture.invalid'},()=> {
      assert.equal(state.configurationRevision('state-test','main'),0)
    })
  } finally {db.close()}
})
