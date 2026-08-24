PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS core_session_identities (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    core_base_url TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS core_session_identities_principal
    ON core_session_identities(principal_key, updated_at);

CREATE TABLE IF NOT EXISTS core_sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    credential_ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed', 'completed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    claimed_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS core_sync_outbox_ready
    ON core_sync_outbox(state, next_attempt_at, id);
