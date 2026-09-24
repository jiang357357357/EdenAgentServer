import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import { BlobRepository } from "../../../src/modules/blobs/repository.ts"
import { accountKey, importAccountPartition, withAccount, type Account } from "../../../src/modules/accounts/index.ts"

function account(userId: string): Account {
  const coreBaseUrl = "http://127.0.0.1:40011"
  return { key: accountKey(coreBaseUrl, userId), coreBaseUrl, userId }
}

test("account partition rejects a target bound to another verified account", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eden-partition-identity-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, "target")
  importAccountPartition(path.join(root, "missing-legacy"), target, account("first"))
  assert.throws(
    () => importAccountPartition(path.join(root, "missing-legacy"), target, account("second")),
    /Account partition identity mismatch/,
  )
})

test("missing historical attachment rolls back the marker and can be retried after file recovery", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "eden-partition-attachment-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, "legacy"),
    target = path.join(root, "target"),
    current = account("owner"),
    contents = "recoverable attachment",
    hash = createHash("sha256").update(contents).digest("hex")
  const legacy = new EdenDatabase(path.join(source, "eden-agent.db"), "mon")
  withAccount(current, () => new BlobRepository(legacy).put(hash, "text/plain", Buffer.byteLength(contents)))
  legacy.close()

  assert.throws(() => importAccountPartition(source, target, current), /Historical attachment file is missing/)
  const rolledBack = new EdenDatabase(path.join(target, "eden-agent.db"), "mon")
  assert.equal(
    rolledBack.connection.prepare("SELECT 1 FROM realm_meta WHERE key='account_partition_imported'").get(),
    undefined,
  )
  rolledBack.close()

  const blob = path.join(source, "blobs", hash.slice(0, 2), hash)
  mkdirSync(path.dirname(blob), { recursive: true })
  writeFileSync(blob, contents)
  importAccountPartition(source, target, current)
  assert.equal(existsSync(path.join(target, "blobs", hash.slice(0, 2), hash)), true)
})
