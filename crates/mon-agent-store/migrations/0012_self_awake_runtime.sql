CREATE TABLE IF NOT EXISTS self_awake_runs (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    request_json TEXT NOT NULL,
    decision_json TEXT,
    author_snapshot_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

ALTER TABLE memos ADD COLUMN operation_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS memos_operation_key
    ON memos(operation_key) WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS self_awake_runs_session
    ON self_awake_runs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS self_awake_diaries (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES self_awake_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    assistant_id TEXT NOT NULL DEFAULT '',
    character_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    mood TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS self_awake_diaries_session
    ON self_awake_diaries(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS self_awake_notifications (
    run_id TEXT PRIMARY KEY NOT NULL REFERENCES self_awake_runs(id) ON DELETE CASCADE,
    requested_channel TEXT NOT NULL DEFAULT 'auto',
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'suppressed')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
