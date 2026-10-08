import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AccountAuthentication } from '../../../src/modules/accounts/authentication.ts'
import { AccountConnection } from '../../../src/modules/accounts/connection.ts'
import { currentAccount, type Account } from '../../../src/modules/accounts/context.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function fixture(t: TestContext) {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const account: Account = { key: 'fixture-account', userId: '101', coreBaseUrl: 'http://127.0.0.1:12345' }
  const authentication = new AccountAuthentication(account.coreBaseUrl)
  let next = () => Promise.resolve(account)
  let calls = 0
  t.mock.method(authentication, 'verify', (token: string) => {
    assert.equal(token, 'fixture-token')
    calls++
    return next()
  })
  const connection = new AccountConnection(authentication, async () => {})
  await connection.initialize('fixture-token')
  return { connection, account, calls: () => calls, advance: (ms: number) => { now += ms },
    verification: (verify: () => Promise<Account>) => { next = verify } }
}

test('fresh account refresh uses its cache and run keeps the verified account context', async t => {
  const { connection, account, calls } = await fixture(t)
  assert.equal(connection.active(), true)
  await connection.refresh()
  assert.equal(await connection.run({}, async () => currentAccount()?.key), account.key)
  assert.equal(calls(), 1)
})

test('concurrent expired refresh and run share one verification and stay inactive until success', async t => {
  const { connection, account, calls, advance, verification } = await fixture(t)
  advance(30_000)
  const pending = deferred<Account>()
  verification(() => pending.promise)
  const first = connection.refresh()
  const second = connection.refresh()
  assert.equal(first, second)
  assert.equal(connection.active(), false)
  let actions = 0
  const running = connection.run({}, () => { actions++; return currentAccount()?.key })
  await setImmediate()
  assert.equal(calls(), 2)
  assert.equal(actions, 0)
  assert.equal(connection.active(), false)
  pending.resolve(account)
  assert.deepEqual(await Promise.all([first, second, running]), [undefined, undefined, account.key])
  assert.equal(actions, 1)
  assert.equal(connection.active(), true)
  await connection.refresh()
  assert.equal(calls(), 2)
})

test('rejected shared verification rejects every caller, stays inactive, and can be revalidated', async t => {
  const { connection, account, calls, advance, verification } = await fixture(t)
  advance(30_000)
  const pending = deferred<Account>()
  const failure = new Error('Core rejected fixture token')
  verification(() => pending.promise)
  const first = connection.refresh()
  const second = connection.refresh()
  let actions = 0
  const running = connection.run({}, () => { actions++ })
  const settled = Promise.allSettled([first, second, running])
  await setImmediate()
  assert.equal(first, second)
  assert.equal(calls(), 2)
  pending.reject(failure)
  for (const result of await settled) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.equal(result.reason, failure)
  }
  assert.equal(actions, 0)
  assert.equal(connection.active(), false)
  verification(() => Promise.resolve(account))
  await connection.refresh()
  assert.equal(calls(), 3)
  assert.equal(connection.active(), true)
})

test('a changed account identity rejects the shared refresh and never activates the new account', async t => {
  const { connection, account, calls, advance, verification } = await fixture(t)
  advance(30_000)
  const pending = deferred<Account>()
  verification(() => pending.promise)
  const first = connection.refresh()
  const second = connection.refresh()
  const settled = Promise.allSettled([first, second])
  await setImmediate()
  assert.equal(calls(), 2)
  assert.equal(connection.active(), false)
  pending.resolve({ ...account, key: 'different-account', userId: '202' })
  const results = await settled
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.match(String(result.reason), /账号身份已改变/)
  }
  assert.equal(first, second)
  assert.equal(connection.account, account)
  assert.equal(connection.active(), false)
})

test('shared refresh cleanup creates no unhandled rejection when verification throws', async t => {
  const { connection, account, advance, verification } = await fixture(t)
  advance(30_000)
  const unhandled: unknown[] = []
  const observe = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', observe)
  t.after(() => { process.off('unhandledRejection', observe) })
  verification(() => { throw new Error('Synchronous fixture verification failure') })
  await Promise.all([assert.rejects(connection.refresh(), /Synchronous fixture/), assert.rejects(connection.refresh(), /Synchronous fixture/)])
  await setImmediate()
  await setImmediate()
  assert.deepEqual(unhandled, [])
  assert.equal(connection.active(), false)
  verification(() => Promise.resolve(account))
  await connection.refresh()
  assert.equal(connection.active(), true)
})
