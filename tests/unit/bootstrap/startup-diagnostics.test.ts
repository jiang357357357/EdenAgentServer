import assert from "node:assert/strict"
import test from "node:test"
import {
  AccountStartupError,
  accountStartupFailure,
  startupStage,
} from "../../../src/bootstrap/startup-diagnostics.ts"

test("startup diagnostics identify processes and accounts without exposing credentials", () => {
  const account = "a".repeat(64)
  const stage = JSON.parse(startupStage("mon", "account.import", account)) as Record<string, unknown>
  assert.equal(stage.event, "server.startup")
  assert.equal(stage.account, account.slice(0, 12))
  assert.equal(stage.pid, process.pid)
  assert.match(String(stage.time), /^\d{4}-\d{2}-\d{2}T/)

  const error = Object.assign(
    new Error(`request failed?token=private-token Bearer private-bearer ${"b".repeat(64)}`),
    { code: "SQLITE_BUSY" },
  )
  const failure = JSON.parse(accountStartupFailure("mon", "account.resume", account, error)) as Record<
    string,
    unknown
  >
  assert.equal(failure.reason, "account_runtime_error")
  assert.equal(failure.errorCode, "SQLITE_BUSY")
  assert.equal(failure.account, account.slice(0, 12))
  assert.doesNotMatch(String(failure.message), /private-token|private-bearer|b{64}/)
})

test("startup diagnostics preserve the failing account stage and actionable migration reason", () => {
  const failure = JSON.parse(
    accountStartupFailure(
      "mon",
      "account.resume",
      "c".repeat(64),
      new AccountStartupError(
        "account.import",
        new Error("Historical attachment file is missing; account import was not committed"),
      ),
    ),
  ) as Record<string, unknown>
  assert.equal(failure.stage, "account.import")
  assert.equal(failure.reason, "historical_attachment_missing")
  assert.equal(failure.retainedForRecovery, true)
})
