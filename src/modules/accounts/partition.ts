import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import path from "node:path"
import { EdenDatabase } from "@eden/store"
import type { Account } from "./context.ts"
import { copyAccountRows } from "./partition-copy.ts"

/** The caller owns the legacy host lock. The original database is never deleted or attached to a live account runtime. */
export function importAccountPartition(legacyRoot: string, dataRoot: string, account: Account): void {
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 })
  const target = new EdenDatabase(path.join(dataRoot, "eden-agent.db"), "mon"),
    db = target.connection
  try {
    const bound = db.prepare("SELECT value FROM realm_meta WHERE key='account_key'").get()
    if (bound && bound.value !== account.key) throw new Error("Account partition identity mismatch")
    if (db.prepare("SELECT 1 FROM realm_meta WHERE key='account_partition_imported'").get()) return
    const legacyFile = path.join(legacyRoot, "eden-agent.db")
    if (existsSync(legacyFile)) {
      db.prepare("ATTACH DATABASE ? AS legacy").run(legacyFile)
      try {
        target.transaction(() => {
          copyAccountRows(db, account.key)
          copyBlobs(
            legacyRoot,
            dataRoot,
            db
              .prepare("SELECT sha256 FROM blobs")
              .all()
              .map((row) => String(row.sha256)),
          )
          db.prepare(
            "INSERT INTO realm_meta(key,value) VALUES('account_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(account.key)
          db.exec("INSERT INTO realm_meta(key,value) VALUES('account_partition_imported','1')")
          if (db.prepare("PRAGMA main.foreign_key_check").all().length)
            throw new Error("Account import contains unresolved references")
        })
      } finally {
        db.exec("DETACH DATABASE legacy")
      }
    } else {
      target.transaction(() => {
        db.prepare("INSERT INTO realm_meta(key,value) VALUES('account_key',?)").run(account.key)
        db.exec("INSERT INTO realm_meta(key,value) VALUES('account_partition_imported','1')")
      })
    }
  } finally {
    target.close()
  }
}
function copyBlobs(source: string, target: string, hashes: string[]): void {
  for (const hash of hashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid historical blob digest")
    const relative = path.join("blobs", hash.slice(0, 2), hash)
    if (!existsSync(path.join(source, relative)))
      throw new Error("Historical attachment file is missing; account import was not committed")
    mkdirSync(path.dirname(path.join(target, relative)), { recursive: true, mode: 0o700 })
    copyFileSync(path.join(source, relative), path.join(target, relative))
  }
}
