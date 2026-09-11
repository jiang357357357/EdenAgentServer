import type { DatabaseSync } from 'node:sqlite'

/** The realm owns one future wake. Completed/cancelled rows remain as audit history. */
export function replacePendingWake(db: DatabaseSync, now: number): void {
  db.prepare("UPDATE jobs SET state='cancelled',error='Replaced by a newer self-awake plan',updated_at=? WHERE kind='self_awake' AND state='queued'").run(now)
}

export function recoverWakes(db: DatabaseSync, now: number): void {
  // A new pending plan wins over dispatch interrupted before committing an input.
  db.prepare(`UPDATE jobs SET state='cancelled',error='Superseded during self-awake recovery',updated_at=?
    WHERE kind='self_awake' AND state IN ('running','queued') AND id NOT IN
    (SELECT id FROM jobs WHERE kind='self_awake' AND state IN ('running','queued') ORDER BY created_at DESC,rowid DESC LIMIT 1)`).run(now)
}

export function wakeBusy(db: DatabaseSync): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM jobs j LEFT JOIN self_awake_runs r ON r.job_id=j.id
    WHERE j.kind='self_awake' AND (j.state IN ('running','dispatched','unknown') OR
      r.state IN ('running','awaiting_action','action_running','action_interrupted')) LIMIT 1`).get())
}
