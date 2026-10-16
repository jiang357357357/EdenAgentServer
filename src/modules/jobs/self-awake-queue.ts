import type { DatabaseSync } from 'node:sqlite'

/** Each session owns one future wake. Completed/cancelled rows remain as audit history. */
export function replacePendingWake(db: DatabaseSync, sessionId: string, now: number, roleScope?: string): void {
  db.prepare(`UPDATE jobs SET state='cancelled',error='Replaced by a newer self-awake plan',updated_at=?
    WHERE (session_id=? OR (? IS NOT NULL AND json_extract(payload_json,'$.roleScope')=?)) AND kind='self_awake' AND state='queued'`).run(now, sessionId, roleScope ?? null, roleScope ?? null)
}

export function recoverWakes(db: DatabaseSync, now: number): void {
  // A new pending plan wins over dispatch interrupted before committing an input.
  db.prepare(`UPDATE jobs SET state='cancelled',error='Superseded during self-awake recovery',updated_at=?
    WHERE kind='self_awake' AND state IN ('running','queued') AND id NOT IN
    (SELECT id FROM jobs AS candidate WHERE COALESCE(json_extract(candidate.payload_json,'$.roleScope'),candidate.session_id)
        IS COALESCE(json_extract(jobs.payload_json,'$.roleScope'),jobs.session_id)
      AND candidate.kind='self_awake' AND candidate.state IN ('running','queued') ORDER BY created_at DESC,rowid DESC LIMIT 1)`).run(now)
}

export function wakeBusy(db: DatabaseSync, sessionId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM jobs j LEFT JOIN self_awake_runs r ON r.job_id=j.id
    WHERE (j.session_id=? OR json_extract(j.payload_json,'$.roleScope')=(SELECT scope_key FROM self_awake_role_members WHERE session_id=?))
      AND j.kind='self_awake' AND (j.state IN ('running','dispatched','unknown') OR
      r.state IN ('running','awaiting_action','action_running','action_interrupted')) LIMIT 1`).get(sessionId, sessionId))
}
