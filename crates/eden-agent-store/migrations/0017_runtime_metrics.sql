CREATE TABLE IF NOT EXISTS runtime_metric_totals (
    metric TEXT PRIMARY KEY NOT NULL,
    value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0)
);

CREATE TABLE IF NOT EXISTS runtime_metric_turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    first_response_at INTEGER,
    PRIMARY KEY (session_id, turn_id)
);

CREATE TABLE IF NOT EXISTS runtime_metric_tool_calls (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn_id, tool_call_id)
);

INSERT OR IGNORE INTO runtime_metric_totals(metric, value) VALUES
    ('turns_started_total', 0),
    ('turns_completed_total', 0),
    ('turns_failed_total', 0),
    ('provider_retries_total', 0),
    ('tool_calls_started_total', 0),
    ('tool_calls_completed_total', 0),
    ('tool_calls_failed_total', 0),
    ('first_token_samples_total', 0),
    ('first_token_duration_ms_total', 0),
    ('turn_duration_samples_total', 0),
    ('turn_duration_ms_total', 0),
    ('tool_duration_samples_total', 0),
    ('tool_duration_ms_total', 0);
