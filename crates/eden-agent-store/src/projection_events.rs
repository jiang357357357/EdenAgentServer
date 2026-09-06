use super::*;

impl Store {
    /// At most 200 recent stable events plus the latest context and character state.
    /// Transient snapshots never enter Rust memory or the Core synchronization payload.
    pub async fn list_sync_snapshot_events(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "WITH recent AS (
                SELECT seq FROM session_events WHERE session_id = ?1
                AND event_type NOT IN ('agent.message_update', 'agent.tool_execution_update',
                    'subagent.agent_message_update', 'subagent.agent_tool_execution_update')
                AND instr(event_type, 'delta') = 0 AND instr(event_type, 'thinking') = 0
                ORDER BY seq DESC LIMIT 200
             ), metadata AS (
                SELECT MAX(seq) AS seq FROM session_events WHERE session_id = ?1
                AND event_type IN ('context.compacted', 'character.action.changed') GROUP BY event_type
             )
             SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events WHERE session_id = ?1
             AND seq IN (SELECT seq FROM recent UNION SELECT seq FROM metadata) ORDER BY seq",
        ).bind(session_id.to_string()).fetch_all(&self.pool).await?;
        rows.iter().map(event_from_row).collect()
    }

    pub async fn list_completed_message_events(
        &self,
        session_id: SessionId,
        after_seq: i64,
        limit: u32,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events WHERE session_id = ? AND event_type = 'agent.message_end'
             AND seq > ? ORDER BY seq LIMIT ?",
        )
        .bind(session_id.to_string())
        .bind(after_seq)
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(event_from_row).collect()
    }

    /// Legacy messages without messageId only need boundaries within their own turn.
    pub async fn list_message_boundaries(
        &self,
        session_id: SessionId,
        turn_id: Option<TurnId>,
        before_seq: i64,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events WHERE session_id = ? AND turn_id IS ? AND seq < ?
             AND event_type IN ('agent.message_start', 'agent.message_end') ORDER BY seq",
        )
        .bind(session_id.to_string())
        .bind(turn_id.map(|id| id.to_string()))
        .bind(before_seq)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(event_from_row).collect()
    }
}
