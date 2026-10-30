import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { HostDeploymentJobs } from '../../../src/modules/shared-workspace/host-deployment-jobs.ts'
import { rpcMethods, redactCredentialJson } from '@eden/api'

test('cloud deployment requires a verified live account and publisher DLC before loading SSH credentials', () => {
  let active = true, canPublish = false, touched = 0
  const jobs = new HostDeploymentJobs({ active: () => active, canPublish: () => canPublish,
    runtime: async () => { touched++; throw new Error('must not load') } })
  const input = rpcMethods['sharedWorkspace.deployHost'].params.parse({ sessionId: randomUUID(), expectedWorkspacePath: '', deployment: {
    host: '127.0.0.1', username: 'fixture', name: 'fixture', fingerprint: 'SHA256:' + 'A'.repeat(43), publicAddress: 'http://127.0.0.1:40195',
    auth: { type: 'password', password: 'never-transmitted-fixture' },
  } }).deployment
  assert.throws(() => jobs.start(input), /DLC/)
  active = false; canPublish = true
  assert.throws(() => jobs.start(input), /连接已关闭/)
  assert.equal(touched, 0)
})

test('SSH password, private key and passphrase are removed by shared credential redaction', () => {
  assert.deepEqual(redactCredentialJson({ auth: { type: 'key', privateKey: 'fixture-private', passphrase: 'fixture-passphrase' }, password: 'fixture-password' }),
    { auth: { type: 'key', privateKey: '[已隐藏凭据]', passphrase: '[已隐藏凭据]' }, password: '[已隐藏凭据]' })
})
