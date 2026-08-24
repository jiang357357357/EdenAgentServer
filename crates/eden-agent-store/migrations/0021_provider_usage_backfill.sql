UPDATE sessions
SET context_usage_json = (
    WITH latest_usage AS (
        SELECT payload_json
        FROM session_events
        WHERE session_id = sessions.id
          AND event_type = 'agent.message_end'
          AND json_extract(payload_json, '$.message.usage.input') IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1
    ),
    provider AS (
        SELECT
            CAST(COALESCE(json_extract(payload_json, '$.message.usage.input'), 0) AS INTEGER) AS input_tokens,
            CAST(COALESCE(json_extract(payload_json, '$.message.usage.output'), 0) AS INTEGER) AS output_tokens,
            MAX(
                CAST(COALESCE(json_extract(payload_json, '$.message.usage.totalTokens'), 0) AS INTEGER),
                CAST(COALESCE(json_extract(payload_json, '$.message.usage.input'), 0) AS INTEGER)
                    + CAST(COALESCE(json_extract(payload_json, '$.message.usage.output'), 0) AS INTEGER)
            ) AS total_tokens,
            CAST(COALESCE(json_extract(payload_json, '$.message.usage.cacheRead'), 0) AS INTEGER) AS cache_read,
            CAST(COALESCE(json_extract(payload_json, '$.message.usage.cacheMiss'), 0) AS INTEGER) AS cache_miss
        FROM latest_usage
    )
    SELECT json_set(
        context_usage_json,
        '$.contextTokens', provider.total_tokens,
        '$.tokenBreakdown.cacheRead', provider.cache_read,
        '$.tokenBreakdown.cacheMiss', provider.cache_miss,
        '$.tokenBreakdown.cacheHitRate', CASE
            WHEN provider.input_tokens > 0
                THEN MIN(1.0, CAST(provider.cache_read AS REAL) / provider.input_tokens)
            ELSE 0.0
        END,
        '$.tokenBreakdown.providerInput', provider.input_tokens,
        '$.tokenBreakdown.providerOutput', provider.output_tokens,
        '$.tokenBreakdown.providerAdjustment', provider.total_tokens - (
            CAST(COALESCE(json_extract(context_usage_json, '$.tokenBreakdown.character'), 0) AS INTEGER)
                + CAST(COALESCE(json_extract(context_usage_json, '$.tokenBreakdown.skills'), 0) AS INTEGER)
                + CAST(COALESCE(json_extract(context_usage_json, '$.tokenBreakdown.system'), 0) AS INTEGER)
                + CAST(COALESCE(json_extract(context_usage_json, '$.tokenBreakdown.tools'), 0) AS INTEGER)
                + CAST(COALESCE(json_extract(context_usage_json, '$.tokenBreakdown.history'), 0) AS INTEGER)
        ),
        '$.tokenBreakdown.contextMeasurement', 'provider',
        '$.source', 'provider_usage_backfill'
    )
    FROM provider
)
WHERE context_usage_json IS NOT NULL
  AND COALESCE(json_extract(context_usage_json, '$.source'), 'migration') IN (
      'migration',
      'provider_usage_backfill'
  )
  AND EXISTS (
      SELECT 1
      FROM session_events
      WHERE session_id = sessions.id
        AND event_type = 'agent.message_end'
        AND json_extract(payload_json, '$.message.usage.input') IS NOT NULL
  );
