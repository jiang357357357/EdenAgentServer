CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('note', 'reminder', 'todo')),
    status TEXT NOT NULL CHECK (status IN ('active', 'done', 'archived', 'cancelled')),
    priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
    remind_at INTEGER,
    due_at INTEGER,
    repeat_rule TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'monagent',
    related_session_id TEXT NOT NULL DEFAULT '',
    last_triggered_at INTEGER,
    snoozed_until INTEGER,
    completed_at INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memos_due
    ON memos(status, snoozed_until, remind_at, due_at);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    source_session_id TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope_type, scope_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'claimed', 'completed', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    idempotency_key TEXT NOT NULL UNIQUE,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, due_at, lease_until);

CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY NOT NULL,
    connector_key TEXT NOT NULL,
    identity_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    desired_state TEXT NOT NULL CHECK (desired_state IN ('connected', 'disconnected')),
    runtime_state TEXT NOT NULL CHECK (runtime_state IN ('offline', 'connecting', 'connected', 'reconnecting', 'error')),
    settings_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(connector_key, identity_key)
);

CREATE TABLE IF NOT EXISTS connector_events (
    id TEXT PRIMARY KEY NOT NULL,
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
    operation_id TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(connector_id, external_id)
);

CREATE INDEX IF NOT EXISTS connector_events_pending ON connector_events(status, created_at);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
