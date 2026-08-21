CREATE TABLE IF NOT EXISTS agent_threads (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES agent_threads(id) ON DELETE CASCADE,
    agent_path TEXT NOT NULL,
    task_name TEXT NOT NULL,
    role TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
    context_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    UNIQUE(session_id, agent_path)
);

CREATE INDEX IF NOT EXISTS agent_threads_session
    ON agent_threads(session_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_mailbox (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sender_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL,
    trigger_turn INTEGER NOT NULL DEFAULT 0,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS agent_mailbox_target
    ON agent_mailbox(session_id, target_path, consumed_at, created_at, id);
