import { z } from 'zod'
import { toJson } from '@eden/api'
import type { EdenDatabase } from '@eden/store'
import type { SessionRepository } from '../sessions/index.ts'
import type { ToolBinding } from './tool-registry.ts'

const selectionSchema = z.object({
  kind: z.enum(['skill', 'tool']), key: z.string(), revision: z.string(), workspaceRoot: z.string(), contextRoot: z.string(), enabled: z.boolean(),
  tools: z.array(z.object({ id: z.string(), name: z.string(), revision: z.string() })),
})
export type CapabilitySelection = z.infer<typeof selectionSchema>

export class SelectionRepository {
  constructor(private readonly database: EdenDatabase, private readonly events: SessionRepository['events']) {}
  list(sessionId: string, owner: string): CapabilitySelection[] {
    return this.database.connection.prepare('SELECT selection_json FROM session_capability_selections WHERE session_id=? AND owner=? ORDER BY kind,key')
      .all(sessionId, owner).map(row => selectionSchema.parse(JSON.parse(String(row.selection_json))))
  }
  save(sessionId: string, owner: string, selections: CapabilitySelection[]): void {
    const parsed = selections.map(selection => selectionSchema.parse(selection))
    const event = this.database.transaction(() => {
      const session = this.database.connection.prepare("SELECT 1 FROM sessions WHERE id=? AND status='active'").get(sessionId)
      if (!session) throw new Error('Capability selection requires an active session')
      const statement = this.database.connection.prepare(`INSERT INTO session_capability_selections VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id,owner,kind,key) DO UPDATE SET selection_json=excluded.selection_json,updated_at=excluded.updated_at`)
      for (const selection of parsed) statement.run(sessionId, owner, selection.kind, selection.key, JSON.stringify(selection), Date.now())
      return this.events.insert(sessionId, null, 'session.capabilities.updated', toJson({ owner, selections: parsed }))
    })
    this.events.publish(event)
  }
  tool(binding: ToolBinding, workspaceRoot: string): CapabilitySelection {
    return { kind: 'tool', key: binding.id, revision: binding.revision, workspaceRoot, contextRoot: workspaceRoot, enabled: true, tools: [binding] }
  }
}
