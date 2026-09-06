-- Internal encoding only: API readers reconstruct the original event payload.
ALTER TABLE session_events ADD COLUMN payload_base_seq INTEGER;
CREATE INDEX session_events_by_type ON session_events(session_id, event_type, seq);
