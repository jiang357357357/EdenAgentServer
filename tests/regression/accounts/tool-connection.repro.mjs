// Retained diagnostic command: node --import tsx Server/tests/regression/accounts/tool-connection.repro.mjs
// Successful refresh must preserve tool events and the frontend connection.
import { runToolConnectionScenario } from './tool-connection-fixture.mjs'

await runToolConnectionScenario()
