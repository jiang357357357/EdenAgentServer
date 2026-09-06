use super::*;

impl Store {
    /// Model history and actor metadata, excluding transient stream snapshots.
    /// The latest compaction and its retained tail are sufficient for replay.
    /// Keep the director's last 20 messages even when they precede that tail.
    pub async fn list_context_events(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "WITH latest AS (
                SELECT seq, payload_json FROM session_events
                WHERE session_id = ?1 AND event_type = 'context.compacted' ORDER BY seq DESC LIMIT 1
             ), boundary AS (
                SELECT COALESCE((SELECT e.seq FROM session_events e, latest c
                    WHERE e.session_id = ?1 AND e.id = json_extract(c.payload_json, '$.firstKeptEntryId')), 0) AS seq
             ), recent AS (
                SELECT COALESCE(MIN(seq), 0) AS seq FROM (
                    SELECT seq FROM session_events WHERE session_id = ?1 AND event_type = 'agent.message_end'
                    AND json_type(payload_json, '$.message.role') = 'text'
                    AND CASE json_type(payload_json, '$.message.content')
                        WHEN 'text' THEN length(trim(json_extract(payload_json, '$.message.content'))) > 0
                        WHEN 'array' THEN EXISTS (
                            SELECT 1 FROM json_each(payload_json, '$.message.content') block
                            WHERE json_extract(block.value, '$.type') = 'text'
                              AND length(trim(json_extract(block.value, '$.text'))) > 0
                        ) ELSE 0 END
                    ORDER BY seq DESC LIMIT 20
                )
             ), metadata AS (
                SELECT MAX(seq) AS seq FROM session_events
                WHERE session_id = ?1 AND event_type IN ('context.cache_state', 'context.skill_snapshot')
                GROUP BY event_type, json_extract(payload_json, '$.assistantId')
             )
             SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events e WHERE session_id = ?1 AND (
                (event_type IN ('agent.message_end', 'turn.completed') AND seq >= MIN((SELECT seq FROM boundary), (SELECT seq FROM recent)))
                OR (event_type = 'context.compacted' AND seq = (SELECT seq FROM latest))
                OR event_type IN ('context.subagent_notification', 'character.action.changed')
                OR (event_type IN ('context.cache_state', 'context.skill_snapshot') AND (
                    (event_type = 'context.skill_snapshot' AND seq >= (SELECT seq FROM boundary))
                    OR seq IN (SELECT seq FROM metadata)
                ))
             ) ORDER BY seq",
        ).bind(session_id.to_string()).fetch_all(&self.pool).await?;
        rows.iter().map(event_from_row).collect()
    }
}
