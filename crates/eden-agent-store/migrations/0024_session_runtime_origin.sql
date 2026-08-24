ALTER TABLE sessions ADD COLUMN runtime_origin TEXT NOT NULL DEFAULT 'mon'
    CHECK (runtime_origin IN ('mon', 'local'));

CREATE INDEX IF NOT EXISTS sessions_runtime_origin_status_updated
    ON sessions(runtime_origin, status, updated_at DESC);
