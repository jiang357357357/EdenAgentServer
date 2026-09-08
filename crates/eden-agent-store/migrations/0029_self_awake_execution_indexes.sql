CREATE INDEX self_awake_started_run ON session_events(json_extract(payload_json, '$.runId'), turn_id) WHERE event_type='self_awake.started';
CREATE INDEX session_events_turn_execution ON session_events(turn_id, event_type, seq);
