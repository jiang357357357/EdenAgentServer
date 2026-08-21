CREATE TABLE IF NOT EXISTS media_requests (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('screen', 'camera')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'rejected', 'expired')),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS media_requests_pending ON media_requests(state, kind, created_at);
