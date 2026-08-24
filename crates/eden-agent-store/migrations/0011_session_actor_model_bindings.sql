PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session_actor_model_bindings (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    assistant_id TEXT NOT NULL,
    ai_entity_id TEXT NOT NULL,
    vision_ai_entity_id TEXT,
    runtime_info_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, assistant_id)
);

CREATE INDEX IF NOT EXISTS session_actor_model_bindings_session
    ON session_actor_model_bindings(session_id, updated_at);
