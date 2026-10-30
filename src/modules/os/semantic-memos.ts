import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { State } from './contracts.ts'

const columns = 'id,title,description,status,priority,progress,scope,intent,created_at,updated_at,due_at,completed_at,context,metadata'
const schema = `CREATE TABLE IF NOT EXISTS semantic_tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT,initiator_type TEXT,initiator_id TEXT,
 subject_type TEXT,subject_id TEXT,object_type TEXT,object_id TEXT,status TEXT,priority TEXT,progress REAL,scope TEXT,intent TEXT,
 created_at TEXT,updated_at TEXT,due_at TEXT,completed_at TEXT,context TEXT,metadata TEXT);
 CREATE INDEX IF NOT EXISTS idx_semantic_tasks_subject_status ON semantic_tasks(subject_type,subject_id,status);`

/** Compatibility repository for the existing SemanticTask SQLite file; Agent's account memos stay separate. */
export class SemanticMemos {
  private readonly db: DatabaseSync
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(filename); this.db.exec('PRAGMA busy_timeout=5000'); this.db.exec(schema)
  }
  create(input: State): State {
    const now = new Date().toISOString(), metadata = { ...(input.metadata ?? {}), session_id: input.metadata?.session_id ?? 'browser' }
    const result = this.db.prepare(`INSERT INTO semantic_tasks (title,description,initiator_type,initiator_id,subject_type,subject_id,object_type,object_id,
      status,priority,progress,scope,intent,created_at,updated_at,due_at,context,metadata)
      VALUES (?,?,'assistant','MonMcp','user','browser','user','browser','active',?,0,'personal',?,?,?,?,?,?)`)
      .run(input.title, input.description ?? '', input.priority ?? 'normal', input.intent ?? 'memo', now, now, input.due_at ?? null,
        JSON.stringify(input.context ?? {}), JSON.stringify(metadata))
    return this.read(Number(result.lastInsertRowid))!
  }
  read(id: number): State | undefined { return this.db.prepare(`SELECT ${columns} FROM semantic_tasks WHERE id=?`).get(id) }
  update(id: number, patch: State): State | undefined {
    const value = this.read(id)
    if (!value) return undefined
    const metadata = JSON.parse(value.metadata || '{}')
    if (patch.due_at !== undefined) for (const key of ['due_notified_at', 'due_notified_due_at', 'due_notified_source']) delete metadata[key]
    const next: State = { ...value, ...patch, updated_at: new Date().toISOString(),
      metadata: patch.metadata === undefined ? metadata : patch.metadata, context: patch.context === undefined ? JSON.parse(value.context || '{}') : patch.context }
    this.db.prepare(`UPDATE semantic_tasks SET title=?,description=?,status=?,priority=?,progress=?,intent=?,updated_at=?,due_at=?,completed_at=?,context=?,metadata=? WHERE id=?`)
      .run(next.title, next.description, next.status, next.priority, Math.max(0, Math.min(1, next.progress ?? 0)), next.intent,
        next.updated_at, next.due_at || null, next.completed_at, JSON.stringify(next.context), JSON.stringify(next.metadata), id)
    return this.read(id)
  }
  complete(id: number) { return this.update(id, { status: 'completed', progress: 1, completed_at: new Date().toISOString() }) }
  delete(id: number) { return this.db.prepare('DELETE FROM semantic_tasks WHERE id=?').run(id).changes > 0 }
  list(input: State): State[] {
    return this.db.prepare(`SELECT ${columns} FROM semantic_tasks WHERE subject_type='user' AND subject_id='browser'
      AND (? IS NULL OR status=?) AND (? IS NULL OR (due_at IS NOT NULL AND due_at<=?)) ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(input.status ?? null, input.status ?? null, input.due_before ?? null, input.due_before ?? null, input.limit ?? 50, input.offset ?? 0)
  }
  public(value: State | undefined): State {
    if (!value) throw new Error('备忘事项不存在')
    const { context: _context, metadata: _metadata, ...result } = value
    return result
  }
  close() { this.db.close() }
}
