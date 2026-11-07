import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const directory = process.argv[2], version = Number(process.argv[3] ?? 1)
mkdirSync(directory, { recursive: true })
const database = new DatabaseSync(path.join(directory, 'todos.db'))
database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
const previous = database.prepare('PRAGMA user_version').get().user_version
if (previous > version) throw new Error('Database schema is newer than this backend')
database.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0)')
if (version >= 2 && previous < 2) database.exec('ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
database.exec(`PRAGMA user_version=${version}`)
const properties = { action: { type: 'string', enum: ['list', 'add', 'update', 'delete', 'fail', 'slow', 'crash_after_add'] },
  title: { type: 'string', minLength: 1 }, id: { type: 'integer', minimum: 1 }, done: { type: 'boolean' },
  priority: { type: 'integer', minimum: 0, maximum: 9 }, delayMs: { type: 'integer', minimum: 0, maximum: 30000 } }
function summary() {
  return { version, pid: process.pid, schemaVersion: database.prepare('PRAGMA user_version').get().user_version,
    todos: database.prepare('SELECT * FROM todos ORDER BY id').all().map(row => ({ ...row, done: Boolean(row.done) })) }
}
async function operation(input) {
  if (input.action === 'fail') return { content: [{ type: 'text', text: 'EXPECTED_TODO_BUSINESS_FAILURE' }], isError: true }
  if (input.action === 'slow') await new Promise(resolve => setTimeout(resolve, input.delayMs ?? 10000))
  if (input.action === 'add' || input.action === 'crash_after_add') {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('A todo title is required')
    database.prepare('INSERT INTO todos(title) VALUES(?)').run(input.title)
    if (input.action === 'crash_after_add') process.exit(17)
  }
  if (input.action === 'update') {
    if (typeof input.done === 'boolean') database.prepare('UPDATE todos SET done=? WHERE id=?').run(Number(input.done), input.id)
    if (typeof input.title === 'string') database.prepare('UPDATE todos SET title=? WHERE id=?').run(input.title, input.id)
    if (input.priority !== undefined) {
      if (version < 2) throw new Error('Priority requires backend v2')
      database.prepare('UPDATE todos SET priority=? WHERE id=?').run(input.priority, input.id)
    }
  }
  if (input.action === 'delete') database.prepare('DELETE FROM todos WHERE id=?').run(input.id)
  const value = summary()
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
const lines = createInterface({ input: process.stdin })
lines.on('line', async line => {
  let request
  try {
    request = JSON.parse(line)
    if (request.id === undefined) return
    let result
    if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Fullstack Todos', version: `${version}.0.0` } }
    else if (request.method === 'tools/list') result = { tools: [{ name: 'todos', description: 'Persist, query and update todo items', inputSchema: { type: 'object', properties, required: ['action'], additionalProperties: false } }] }
    else if (request.method === 'tools/call' && request.params.name === 'todos') result = await operation(request.params.arguments)
    else throw new Error('Unknown method or tool')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: String(error.message) } }) + '\n')
  }
})
