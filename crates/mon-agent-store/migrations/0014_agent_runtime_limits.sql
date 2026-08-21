ALTER TABLE agent_threads ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_threads ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_threads ADD COLUMN deadline_at INTEGER;
ALTER TABLE agent_threads ADD COLUMN coordination_batch_id TEXT;

CREATE INDEX IF NOT EXISTS agent_threads_batch
    ON agent_threads(session_id, coordination_batch_id, created_at, id);
