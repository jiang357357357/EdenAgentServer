CREATE TABLE IF NOT EXISTS question_requests (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'rejected', 'expired')),
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS question_requests_pending
    ON question_requests(state, session_id, created_at);
