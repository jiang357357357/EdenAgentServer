CREATE TABLE IF NOT EXISTS workspace_state (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    current_path TEXT NOT NULL,
    pending_path TEXT,
    pending_session_id TEXT,
    requested_at INTEGER,
    updated_at INTEGER NOT NULL
);
