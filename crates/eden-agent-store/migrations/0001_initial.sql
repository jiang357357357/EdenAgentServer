PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_inputs (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'completed', 'interrupted')),
    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS session_inputs_ready
    ON session_inputs(session_id, state, created_at);

CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    turn_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_events_ordered
    ON session_events(session_id, seq);

CREATE TABLE IF NOT EXISTS permission_requests (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    capability TEXT NOT NULL,
    resource TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'allowed', 'denied', 'expired')),
    request_json TEXT NOT NULL,
    decision_json TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    storage_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
