ALTER TABLE sessions ADD COLUMN context_usage_json TEXT;

-- Existing installations did not materialize context usage. Seed them from
-- the latest persisted prompt breakdown so reopening an old session never
-- falls back to counting every historical tool payload in the browser.
UPDATE sessions
SET context_usage_json = (
    SELECT json_object(
        'contextTokens', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.total'), 0),
        'tokenBreakdown', json_object(
            'character', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.identity'), 0),
            'skills', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.skills'), 0),
            'system', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.system'), 0),
            'tools', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.tools'), 0),
            'history', COALESCE(json_extract(event.payload_json, '$.tokenBreakdown.history'), 0),
            'cacheRead', 0,
            'cacheMiss', 0,
            'cacheHitRate', 0,
            'promptCacheFingerprint', json_extract(event.payload_json, '$.cache.fingerprint'),
            'promptCacheEpoch', COALESCE(json_extract(event.payload_json, '$.cache.epoch'), 0),
            'promptCacheInvalidationReason', json_extract(event.payload_json, '$.cache.invalidationReason')
        ),
        'source', 'migration',
        'updatedAt', event.created_at
    )
    FROM session_events AS event
    WHERE event.session_id = sessions.id
      AND event.event_type = 'context.cache_state'
    ORDER BY event.seq DESC
    LIMIT 1
)
WHERE context_usage_json IS NULL
  AND EXISTS (
      SELECT 1 FROM session_events AS event
      WHERE event.session_id = sessions.id
        AND event.event_type = 'context.cache_state'
  );
