import { test as nodeTest, type TestContext, type TestOptions } from 'node:test'
import { accountKey, withAccount } from '../../src/modules/accounts/index.ts'

const coreBaseUrl = 'http://127.0.0.1:40011', userId = 'isolated-regression-fixture'
const account = { userId, coreBaseUrl, key: accountKey(coreBaseUrl, userId) }
type Body = (context: TestContext) => void | Promise<void>

/** Legacy Mon fixtures still require an authenticated owner; never relax the queue guard. */
export function test(name: string, optionsOrBody: TestOptions | Body, body?: Body) {
  const run = typeof optionsOrBody === 'function' ? optionsOrBody : body!
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody
  return nodeTest(name, options, context => withAccount(account, () => run(context)))
}
