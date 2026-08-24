CREATE TABLE IF NOT EXISTS session_model_bindings (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    assistant_id TEXT NOT NULL DEFAULT '',
    ai_entity_id TEXT NOT NULL,
    vision_ai_entity_id TEXT,
    runtime_info_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS session_model_bindings_entity
    ON session_model_bindings(ai_entity_id, updated_at DESC);
