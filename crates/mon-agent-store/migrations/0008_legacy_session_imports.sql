CREATE TABLE IF NOT EXISTS legacy_session_imports (
    source_kind TEXT NOT NULL,
    legacy_session_key TEXT NOT NULL,
    target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    legacy_user_id INTEGER NOT NULL,
    imported_message_count INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY(source_kind, legacy_session_key),
    UNIQUE(target_session_id)
);

