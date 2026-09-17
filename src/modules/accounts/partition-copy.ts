import type { DatabaseSync } from "node:sqlite"
import { copyReferencedContent } from "./partition-content.ts"

interface Table {
  name: string
  columns: string[]
  foreign: { id: number; table: string; from: string; to: string }[]
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
function tables(db: DatabaseSync): Table[] {
  return db
    .prepare("SELECT name FROM legacy.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => {
      const name = String(row.name)
      return {
        name,
        columns: db
          .prepare(`PRAGMA legacy.table_info(${quote(name)})`)
          .all()
          .map((item) => String(item.name)),
        foreign: db
          .prepare(`PRAGMA legacy.foreign_key_list(${quote(name)})`)
          .all()
          .map((item) => ({
            id: Number(item.id),
            table: String(item.table),
            from: String(item.from),
            to: String(item.to),
          })),
      }
    })
}
function copy(db: DatabaseSync, table: Table, predicate: string): number {
  const fields = table.columns.map(quote).join(",")
  return Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO main.${quote(table.name)}(rowid,${fields}) SELECT x.rowid,${table.columns.map((c) => "x." + quote(c)).join(",")}
    FROM legacy.${quote(table.name)} x WHERE ${predicate}`,
      )
      .run().changes,
  )
}
function dependencies(table: Table): string[] {
  const groups = new Map<number, Table["foreign"]>()
  for (const key of table.foreign) groups.set(key.id, [...(groups.get(key.id) ?? []), key])
  return [...groups.values()].map(
    (keys) =>
      `(${keys.map((k) => `x.${quote(k.from)} IS NULL`).join(" OR ")} OR EXISTS(SELECT 1 FROM main.${quote(keys[0]!.table)} p WHERE ${keys.map((k) => `p.${quote(k.to)}=x.${quote(k.from)}`).join(" AND ")}))`,
  )
}
/** Import only rows reachable from verified account ownership; unowned global configuration stays quarantined. */
export function copyAccountRows(db: DatabaseSync, accountKey: string): void {
  const catalog = tables(db),
    byName = new Map(catalog.map((table) => [table.name, table]))
  db.prepare(
    "INSERT INTO sessions SELECT s.* FROM legacy.sessions s JOIN legacy.session_owners o ON o.session_id=s.id WHERE o.account_key=?",
  ).run(accountKey)
  db.prepare("INSERT INTO account_records SELECT * FROM legacy.account_records WHERE account_key=?").run(accountKey)
  db.prepare("INSERT INTO account_ui_preferences SELECT * FROM legacy.account_ui_preferences WHERE account_key=?").run(
    accountKey,
  )
  copy(db, byName.get("memories")!, "x.id IN (SELECT record_id FROM account_records WHERE kind='memory')")
  copy(db, byName.get("memos")!, "x.id IN (SELECT record_id FROM account_records WHERE kind='memo')")
  copy(db, byName.get("model_bindings")!, "x.session_key IN (SELECT id FROM sessions)")
  copy(
    db,
    byName.get("voice_audio_cache")!,
    "x.cache_key IN (SELECT cache_key FROM legacy.voice_speech_segments WHERE session_id IN (SELECT id FROM main.sessions))",
  )
  const included = new Set([
    "sessions",
    "memories",
    "memos",
    "model_bindings",
    "voice_audio_cache",
    "account_records",
    "account_ui_preferences",
  ])
  const excluded = new Set(["realm_meta", "schema_migrations", "blobs", "blob_owners", "request_contents"])
  let added = true
  while (added) {
    added = false
    for (const table of catalog) {
      if (included.has(table.name) || excluded.has(table.name)) continue
      const ownColumns = table.columns.filter((c) =>
        [
          "session_id",
          "source_session_id",
          "target_session_id",
          "root_session_id",
          "parent_session_id",
          "child_session_id",
          "sender_session_id",
        ].includes(c),
      )
      if (ownColumns.length || table.foreign.some((key) => included.has(key.table))) {
        included.add(table.name)
        added = true
      }
    }
  }
  let changed: number
  do {
    changed = 0
    for (const table of catalog) {
      if (
        !included.has(table.name) ||
        [
          "sessions",
          "account_records",
          "account_ui_preferences",
          "memories",
          "memos",
          "model_bindings",
          "voice_audio_cache",
        ].includes(table.name)
      )
        continue
      const scope = table.columns
        .filter((c) => c.endsWith("session_id"))
        .map((c) => `(x.${quote(c)} IS NULL OR x.${quote(c)}='' OR x.${quote(c)} IN (SELECT id FROM main.sessions))`)
      const roots = table.columns
        .filter((c) => c.endsWith("session_id"))
        .map((c) => `x.${quote(c)} IN (SELECT id FROM main.sessions)`)
      const parents = table.foreign
        .filter((key) => included.has(key.table))
        .map((key) => `EXISTS(SELECT 1 FROM main.${quote(key.table)} p WHERE p.${quote(key.to)}=x.${quote(key.from)})`)
      const predicates = [...scope, ...dependencies(table), `(${[...roots, ...parents].join(" OR ") || "0"})`]
      changed += copy(db, table, predicates.join(" AND "))
    }
  } while (changed)
  copyReferencedContent(db, accountKey)
}
