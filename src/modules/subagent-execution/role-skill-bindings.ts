import { z } from 'zod'
import type { EdenDatabase } from '@eden/store'

const bindings = z.array(z.object({ name: z.string(), contentHash: z.string(), workspaceRoot: z.string() }))

export function roleSkillBindings(database: EdenDatabase, sessionId: string) {
  const row = database.connection.prepare(`SELECT s.skills_json FROM subagent_role_snapshots s
    JOIN subagent_threads t ON t.id=s.agent_id WHERE t.child_session_id=?`).get(sessionId)
  return row ? bindings.parse(JSON.parse(String(row.skills_json))) : []
}
