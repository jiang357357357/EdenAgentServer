CREATE TABLE desktop_reminders (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 operation_key TEXT NOT NULL,
 run_id TEXT REFERENCES self_awake_runs(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 message TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('launching','open','closed','failed','unknown')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(session_id, operation_key)
);
CREATE INDEX desktop_reminders_run ON desktop_reminders(run_id);
