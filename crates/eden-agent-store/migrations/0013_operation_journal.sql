CREATE TABLE IF NOT EXISTS operation_journal (
    operation_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    capability TEXT NOT NULL DEFAULT '',
    resource TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN (
        'planned', 'authorized', 'started', 'committed', 'failed', 'unknown'
    )),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, turn_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS operation_journal_state
    ON operation_journal(state, updated_at);
