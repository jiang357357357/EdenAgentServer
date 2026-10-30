import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import ssh2, { type Connection } from 'ssh2'
import type { AddressInfo } from 'node:net'
import type { SharedHostDeploymentInput } from '@eden/api'
import { connectSsh, probeSshHost, sshNodeScript } from '../../../src/modules/shared-workspace/host-ssh.ts'

async function fixture(t: TestContext) {
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const userPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'fixture-key-passphrase' })
  const userKey = ssh2.utils.parseKey(userPrivateKey, 'fixture-key-passphrase')
  assert.ok(!(userKey instanceof Error) && !Array.isArray(userKey))
  let authentications = 0
  const commands: string[] = [], clients = new Set<Connection>()
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', context => {
      authentications++
      if (context.method === 'password' && context.username === 'fixture' && context.password === 'fixture-ssh-secret') context.accept()
      else if (context.method === 'publickey' && context.username === 'fixture' && context.key.data.equals(userKey.getPublicSSH())
        && (!context.signature || userKey.verify(context.blob!, context.signature, context.hashAlgo))) context.accept()
      else context.reject()
    })
    client.on('session', accept => {
      const session = accept()
      session.on('exec', (acceptExec, _reject, request) => {
        commands.push(request.command)
        const stream = acceptExec(), child = spawn(process.execPath, ['--input-type=module'], { stdio: 'pipe' })
        stream.pipe(child.stdin); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr)
        child.once('close', code => { stream.exit(code ?? 1); stream.end() })
        stream.once('close', () => child.kill())
        child.stdin.on('error', () => {})
      })
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'fixture' }
  return { target, authentications: () => authentications, commands, userPrivateKey: String(userPrivateKey) }
}
function deployment(target: { host: string; port: number; username: string }, fingerprint: string): SharedHostDeploymentInput {
  return { ...target, fingerprint, auth: { type: 'password', password: 'fixture-ssh-secret' }, directory: '', name: 'fixture',
    publicAddress: 'http://127.0.0.1:40195', servicePort: 40195, installService: false }
}

test('SSH host-key probe performs no credential authentication; a changed fingerprint stops authentication', async t => {
  const f = await fixture(t), controller = new AbortController()
  const observed = await probeSshHost(f.target, controller.signal)
  assert.match(observed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(f.authentications(), 0)
  await assert.rejects(connectSsh(deployment(f.target, 'SHA256:' + 'A'.repeat(43)), controller.signal), /指纹不匹配/)
  assert.equal(f.authentications(), 0)
})

test('verified SSH executes stdin source, streams progress and never places deployment secrets in shell arguments', async t => {
  const f = await fixture(t), controller = new AbortController()
  const observed = await probeSshHost(f.target, controller.signal)
  const client = await connectSsh(deployment(f.target, observed.fingerprint), controller.signal)
  try {
    const lines: string[] = []
    await sshNodeScript(client, 'node', `process.stdout.write(JSON.stringify({ phase: 'preflight', name: '云端部署' }) + '\\n')`, controller.signal, line => lines.push(line))
    assert.equal(JSON.parse(lines[0]!).name, '云端部署')
    assert.deepEqual(f.commands, ["'node' --input-type=module"])
    assert.doesNotMatch(f.commands.join(''), /fixture-ssh-secret/)
  } finally { client.end() }
})

test('cancelling a running SSH channel closes it and rejects the operation promptly', async t => {
  const f = await fixture(t), controller = new AbortController()
  const observed = await probeSshHost(f.target, controller.signal)
  const client = await connectSsh(deployment(f.target, observed.fingerprint), controller.signal)
  const operation = sshNodeScript(client, 'node', 'setInterval(() => {}, 1000)', controller.signal, () => {})
  controller.abort()
  await assert.rejects(operation, /取消/)
})

test('encrypted private-key authentication accepts the correct passphrase without transmitting the private key', async t => {
  const f = await fixture(t), controller = new AbortController()
  const observed = await probeSshHost(f.target, controller.signal)
  const input = { ...deployment(f.target, observed.fingerprint), auth: { type: 'key' as const, privateKey: f.userPrivateKey, passphrase: 'fixture-key-passphrase' } }
  const client = await connectSsh(input, controller.signal)
  client.end()
  await assert.rejects(connectSsh({ ...input, auth: { ...input.auth, passphrase: 'wrong-fixture-passphrase' } }, controller.signal), /私钥|认证/)
})
