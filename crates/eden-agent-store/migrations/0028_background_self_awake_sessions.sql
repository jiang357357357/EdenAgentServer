-- Existing scheduler sessions are identified by ownership metadata, never title.
UPDATE sessions SET environment_json = json_set(environment_json, '$.sessionPurpose', 'self_awake')
WHERE json_extract(environment_json, '$.selfAwakeUserId') IS NOT NULL;

-- Cancel queued chat projections only; keep events, messages, jobs and notifications.
UPDATE core_sync_outbox SET state = 'completed', claimed_at = NULL,
    last_error = 'background session: chat projection suppressed'
WHERE kind IN ('session', 'message', 'director') AND state != 'completed'
AND session_id IN (SELECT id FROM sessions WHERE json_extract(environment_json, '$.sessionPurpose') = 'self_awake');
