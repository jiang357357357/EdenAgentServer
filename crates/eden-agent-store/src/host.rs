use super::{Store, StoreError, append_event_tx, ensure_session, now_ms};
use eden_agent_domain::{OperationId, SessionId, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoRecord {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub status: String,
    pub priority: String,
    pub remind_at: Option<i64>,
    pub due_at: Option<i64>,
    pub repeat_rule: String,
    pub source: String,
    pub related_session_id: String,
    pub last_triggered_at: Option<i64>,
    pub snoozed_until: Option<i64>,
    pub completed_at: Option<i64>,
    pub metadata: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoInput {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_memo_kind")]
    pub kind: String,
    #[serde(default = "default_active")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub remind_at: Option<i64>,
    pub due_at: Option<i64>,
    #[serde(default)]
    pub repeat_rule: String,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub related_session_id: String,
    #[serde(default)]
    pub metadata: Value,
}

impl Default for MemoInput {
    fn default() -> Self {
        Self {
            title: String::new(),
            content: String::new(),
            kind: default_memo_kind(),
            status: default_active(),
            priority: default_priority(),
            remind_at: None,
            due_at: None,
            repeat_rule: String::new(),
            source: default_source(),
            related_session_id: String::new(),
            metadata: json!({}),
        }
    }
}

fn default_memo_kind() -> String {
    "note".to_owned()
}
fn default_active() -> String {
    "active".to_owned()
}
fn default_priority() -> String {
    "normal".to_owned()
}
fn default_source() -> String {
    "edenagent".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: i64,
    pub content: String,
    pub kind: String,
    pub scope_type: String,
    pub scope_key: String,
    pub source_session_id: String,
    pub metadata: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelBindingRecord {
    pub session_id: SessionId,
    pub assistant_id: String,
    pub ai_entity_id: String,
    pub vision_ai_entity_id: Option<String>,
    pub runtime_info: Value,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActorModelBindingRecord {
    pub session_id: SessionId,
    pub assistant_id: String,
    pub ai_entity_id: String,
    pub vision_ai_entity_id: Option<String>,
    pub runtime_info: Value,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSessionIdentityRecord {
    pub session_id: SessionId,
    pub core_base_url: String,
    pub principal_key: String,
    pub credential_ref: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreSyncOutboxRecord {
    pub id: i64,
    pub session_id: SessionId,
    pub credential_ref: String,
    pub kind: String,
    pub dedupe_key: String,
    pub payload: Value,
    pub state: String,
    pub attempts: i64,
    pub next_attempt_at: i64,
    pub claimed_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: Uuid,
    pub kind: String,
    pub session_id: Option<SessionId>,
    pub due_at: i64,
    pub payload: Value,
    pub state: String,
    pub attempts: i64,
    pub lease_until: Option<i64>,
    pub idempotency_key: String,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakeRunRecord {
    pub id: Uuid,
    pub job_id: Uuid,
    pub session_id: SessionId,
    pub schema_version: String,
    pub event_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub request: Value,
    pub decision: Option<Value>,
    pub author_snapshot: Value,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakeDiaryRecord {
    pub id: Uuid,
    pub run_id: Uuid,
    pub session_id: SessionId,
    pub assistant_id: String,
    pub character_id: String,
    pub title: String,
    pub content: String,
    pub mood: String,
    pub metadata: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationJournalRecord {
    pub operation_id: OperationId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub tool_call_id: String,
    pub tool_name: String,
    pub capability: String,
    pub resource: String,
    pub state: String,
    pub request: Value,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRecord {
    pub id: Uuid,
    pub connector_key: String,
    pub identity_key: String,
    pub display_name: String,
    pub desired_state: String,
    pub runtime_state: String,
    pub settings: Value,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorEventRecord {
    pub id: Uuid,
    pub connector_id: Uuid,
    pub external_id: String,
    pub event_type: String,
    pub payload: Value,
    pub status: String,
    pub operation_id: Option<Uuid>,
    pub lease_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequestRecord {
    pub id: Uuid,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub kind: String,
    pub state: String,
    pub request: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

impl Store {
    pub async fn get_config(&self, key: &str) -> Result<Option<Value>, StoreError> {
        let value =
            sqlx::query_scalar::<_, String>("SELECT value_json FROM app_config WHERE key=?")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(StoreError::from))
            .transpose()
    }

    pub async fn set_config(&self, key: &str, value: Value) -> Result<(), StoreError> {
        sqlx::query("INSERT INTO app_config(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
            .bind(key)
            .bind(serde_json::to_string(&value)?)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_session_model_binding(
        &self,
        session_id: SessionId,
        assistant_id: &str,
        ai_entity_id: &str,
        vision_ai_entity_id: Option<&str>,
        runtime_info: Value,
    ) -> Result<SessionModelBindingRecord, StoreError> {
        let now = now_ms();
        let runtime_info = sanitize_model_runtime_info(&runtime_info);
        sqlx::query(
            "INSERT INTO session_model_bindings(session_id, assistant_id, ai_entity_id, vision_ai_entity_id, runtime_info_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET assistant_id=excluded.assistant_id, ai_entity_id=excluded.ai_entity_id,
             vision_ai_entity_id=excluded.vision_ai_entity_id, runtime_info_json=excluded.runtime_info_json, updated_at=excluded.updated_at",
        )
        .bind(session_id.to_string())
        .bind(assistant_id)
        .bind(ai_entity_id)
        .bind(vision_ai_entity_id)
        .bind(serde_json::to_string(&runtime_info)?)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_session_model_binding(session_id)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidValue("session model binding was not stored".to_owned())
            })
    }

    pub async fn get_session_model_binding(
        &self,
        session_id: SessionId,
    ) -> Result<Option<SessionModelBindingRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM session_model_bindings WHERE session_id=?")
            .bind(session_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(session_model_binding_from_row).transpose()
    }

    pub async fn list_session_model_bindings(
        &self,
    ) -> Result<Vec<SessionModelBindingRecord>, StoreError> {
        let rows = sqlx::query("SELECT * FROM session_model_bindings ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(session_model_binding_from_row).collect()
    }

    pub async fn delete_session_model_binding(
        &self,
        session_id: SessionId,
    ) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM session_model_bindings WHERE session_id=?")
            .bind(session_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_session_actor_model_binding(
        &self,
        session_id: SessionId,
        assistant_id: &str,
        ai_entity_id: &str,
        vision_ai_entity_id: Option<&str>,
        runtime_info: Value,
    ) -> Result<SessionActorModelBindingRecord, StoreError> {
        let now = now_ms();
        let runtime_info = sanitize_model_runtime_info(&runtime_info);
        sqlx::query(
            "INSERT INTO session_actor_model_bindings(session_id, assistant_id, ai_entity_id, vision_ai_entity_id, runtime_info_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, assistant_id) DO UPDATE SET ai_entity_id=excluded.ai_entity_id,
             vision_ai_entity_id=excluded.vision_ai_entity_id, runtime_info_json=excluded.runtime_info_json,
             updated_at=excluded.updated_at",
        )
        .bind(session_id.to_string())
        .bind(assistant_id)
        .bind(ai_entity_id)
        .bind(vision_ai_entity_id)
        .bind(serde_json::to_string(&runtime_info)?)
        .bind(now)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query(
            "SELECT * FROM session_actor_model_bindings WHERE session_id=? AND assistant_id=?",
        )
        .bind(session_id.to_string())
        .bind(assistant_id)
        .fetch_one(&self.pool)
        .await?;
        session_actor_model_binding_from_row(&row)
    }

    pub async fn list_session_actor_model_bindings(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<Vec<SessionActorModelBindingRecord>, StoreError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT * FROM session_actor_model_bindings WHERE session_id=? ORDER BY updated_at DESC",
            )
            .bind(session_id.to_string())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query("SELECT * FROM session_actor_model_bindings ORDER BY updated_at DESC")
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter()
            .map(session_actor_model_binding_from_row)
            .collect()
    }

    pub async fn delete_session_actor_model_bindings(
        &self,
        session_id: SessionId,
    ) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM session_actor_model_bindings WHERE session_id=?")
            .bind(session_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_core_session_identity(
        &self,
        session_id: SessionId,
        core_base_url: &str,
        principal_key: &str,
        credential_ref: &str,
    ) -> Result<CoreSessionIdentityRecord, StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO core_session_identities(session_id, core_base_url, principal_key, credential_ref, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET core_base_url=excluded.core_base_url,
             principal_key=excluded.principal_key, credential_ref=excluded.credential_ref, updated_at=excluded.updated_at",
        )
        .bind(session_id.to_string())
        .bind(core_base_url.trim_end_matches('/'))
        .bind(principal_key)
        .bind(credential_ref)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_core_session_identity(session_id)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidValue("Core session identity was not stored".to_owned())
            })
    }

    pub async fn get_core_session_identity(
        &self,
        session_id: SessionId,
    ) -> Result<Option<CoreSessionIdentityRecord>, StoreError> {
        let row = sqlx::query("SELECT * FROM core_session_identities WHERE session_id=?")
            .bind(session_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(core_session_identity_from_row).transpose()
    }

    pub async fn list_core_session_identities(
        &self,
    ) -> Result<Vec<CoreSessionIdentityRecord>, StoreError> {
        let rows = sqlx::query("SELECT * FROM core_session_identities ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(core_session_identity_from_row).collect()
    }

    pub async fn enqueue_core_sync(
        &self,
        session_id: SessionId,
        credential_ref: &str,
        kind: &str,
        dedupe_key: &str,
        payload: Value,
    ) -> Result<CoreSyncOutboxRecord, StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO core_sync_outbox(session_id, credential_ref, kind, dedupe_key, payload_json, state, attempts, next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
             ON CONFLICT(dedupe_key) DO UPDATE SET credential_ref=excluded.credential_ref,
             payload_json=excluded.payload_json, state='queued', next_attempt_at=excluded.next_attempt_at,
             claimed_at=NULL, last_error=NULL, updated_at=excluded.updated_at",
        )
        .bind(session_id.to_string())
        .bind(credential_ref)
        .bind(kind)
        .bind(dedupe_key)
        .bind(serde_json::to_string(&payload)?)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_core_sync_by_key(dedupe_key).await
    }

    pub async fn claim_core_sync(
        &self,
        limit: u32,
        lease_ms: i64,
    ) -> Result<Vec<CoreSyncOutboxRecord>, StoreError> {
        let now = now_ms();
        let expired = now.saturating_sub(lease_ms.max(1));
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "UPDATE core_sync_outbox SET state='queued', claimed_at=NULL, updated_at=?
             WHERE state='claimed' AND claimed_at < ?",
        )
        .bind(now)
        .bind(expired)
        .execute(&mut *transaction)
        .await?;
        let rows = sqlx::query(
            "SELECT * FROM core_sync_outbox WHERE state='queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
        )
        .bind(now)
        .bind(i64::from(limit.clamp(1, 100)))
        .fetch_all(&mut *transaction)
        .await?;
        let mut records = Vec::new();
        for row in rows {
            let record = core_sync_outbox_from_row(&row)?;
            let updated = sqlx::query(
                "UPDATE core_sync_outbox SET state='claimed', claimed_at=?, updated_at=? WHERE id=? AND state='queued'",
            )
            .bind(now)
            .bind(now)
            .bind(record.id)
            .execute(&mut *transaction)
            .await?;
            if updated.rows_affected() == 1 {
                records.push(CoreSyncOutboxRecord {
                    state: "claimed".to_owned(),
                    claimed_at: Some(now),
                    updated_at: now,
                    ..record
                });
            }
        }
        transaction.commit().await?;
        Ok(records)
    }

    pub async fn complete_core_sync(&self, id: i64) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE core_sync_outbox SET state='completed', claimed_at=NULL, last_error=NULL, updated_at=? WHERE id=?",
        )
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn retry_core_sync(
        &self,
        id: i64,
        error: &str,
        delay_ms: i64,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        sqlx::query(
            "UPDATE core_sync_outbox SET state='queued', attempts=attempts+1, next_attempt_at=?, claimed_at=NULL,
             last_error=?, updated_at=? WHERE id=?",
        )
        .bind(now.saturating_add(delay_ms.max(0)))
        .bind(error.chars().take(2_000).collect::<String>())
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_core_sync_outbox(
        &self,
        state: Option<&str>,
        limit: u32,
    ) -> Result<Vec<CoreSyncOutboxRecord>, StoreError> {
        let rows = if let Some(state) = state {
            sqlx::query("SELECT * FROM core_sync_outbox WHERE state=? ORDER BY id DESC LIMIT ?")
                .bind(state)
                .bind(i64::from(limit.clamp(1, 500)))
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM core_sync_outbox ORDER BY id DESC LIMIT ?")
                .bind(i64::from(limit.clamp(1, 500)))
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(core_sync_outbox_from_row).collect()
    }

    async fn get_core_sync_by_key(
        &self,
        dedupe_key: &str,
    ) -> Result<CoreSyncOutboxRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM core_sync_outbox WHERE dedupe_key=?")
            .bind(dedupe_key)
            .fetch_one(&self.pool)
            .await?;
        core_sync_outbox_from_row(&row)
    }

    pub async fn create_memo(&self, input: MemoInput) -> Result<MemoRecord, StoreError> {
        validate_memo(&input)?;
        let now = now_ms();
        let result = sqlx::query(
            "INSERT INTO memos(title, content, kind, status, priority, remind_at, due_at,
             repeat_rule, source, related_session_id, metadata_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(input.title.trim())
        .bind(input.content)
        .bind(input.kind)
        .bind(input.status)
        .bind(input.priority)
        .bind(input.remind_at)
        .bind(input.due_at)
        .bind(input.repeat_rule)
        .bind(input.source)
        .bind(input.related_session_id)
        .bind(serde_json::to_string(&input.metadata)?)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_memo(result.last_insert_rowid()).await
    }

    pub async fn create_memo_idempotent(
        &self,
        input: MemoInput,
        operation_key: &str,
    ) -> Result<MemoRecord, StoreError> {
        validate_memo(&input)?;
        if operation_key.trim().is_empty() {
            return Err(StoreError::InvalidValue(
                "memo operation key cannot be empty".to_owned(),
            ));
        }
        let now = now_ms();
        sqlx::query(
            "INSERT INTO memos(title, content, kind, status, priority, remind_at, due_at,
             repeat_rule, source, related_session_id, metadata_json, created_at, updated_at, operation_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(operation_key) DO NOTHING",
        )
        .bind(input.title.trim())
        .bind(input.content)
        .bind(input.kind)
        .bind(input.status)
        .bind(input.priority)
        .bind(input.remind_at)
        .bind(input.due_at)
        .bind(input.repeat_rule)
        .bind(input.source)
        .bind(input.related_session_id)
        .bind(serde_json::to_string(&input.metadata)?)
        .bind(now)
        .bind(now)
        .bind(operation_key)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query("SELECT * FROM memos WHERE operation_key=?")
            .bind(operation_key)
            .fetch_one(&self.pool)
            .await?;
        memo_from_row(&row)
    }

    pub async fn get_memo(&self, id: i64) -> Result<MemoRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM memos WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        memo_from_row(&row)
    }

    pub async fn list_memos(
        &self,
        limit: u32,
        query: Option<&str>,
    ) -> Result<Vec<MemoRecord>, StoreError> {
        let rows = if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            let pattern = format!("%{}%", query.trim());
            sqlx::query("SELECT * FROM memos WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC, id DESC LIMIT ?")
                .bind(&pattern).bind(&pattern).bind(i64::from(limit.clamp(1, 200))).fetch_all(&self.pool).await?
        } else {
            sqlx::query("SELECT * FROM memos ORDER BY updated_at DESC, id DESC LIMIT ?")
                .bind(i64::from(limit.clamp(1, 200)))
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(memo_from_row).collect()
    }

    pub async fn update_memo(&self, id: i64, patch: Value) -> Result<MemoRecord, StoreError> {
        let current = self.get_memo(id).await?;
        let input = MemoInput {
            title: string_patch(&patch, "title").unwrap_or(current.title),
            content: string_patch(&patch, "content").unwrap_or(current.content),
            kind: string_patch(&patch, "kind").unwrap_or(current.kind),
            status: string_patch(&patch, "status").unwrap_or(current.status),
            priority: string_patch(&patch, "priority").unwrap_or(current.priority),
            remind_at: optional_i64_patch(&patch, "remindAt", current.remind_at),
            due_at: optional_i64_patch(&patch, "dueAt", current.due_at),
            repeat_rule: string_patch(&patch, "repeatRule").unwrap_or(current.repeat_rule),
            source: current.source,
            related_session_id: current.related_session_id,
            metadata: patch.get("metadata").cloned().unwrap_or(current.metadata),
        };
        validate_memo(&input)?;
        let completed_at = if input.status == "done" {
            Some(now_ms())
        } else {
            current.completed_at
        };
        sqlx::query("UPDATE memos SET title=?, content=?, kind=?, status=?, priority=?, remind_at=?, due_at=?, repeat_rule=?, metadata_json=?, completed_at=?, updated_at=? WHERE id=?")
            .bind(input.title).bind(input.content).bind(input.kind).bind(input.status).bind(input.priority)
            .bind(input.remind_at).bind(input.due_at).bind(input.repeat_rule).bind(serde_json::to_string(&input.metadata)?)
            .bind(completed_at).bind(now_ms()).bind(id).execute(&self.pool).await?;
        self.get_memo(id).await
    }

    pub async fn due_memos(&self, before: i64, limit: u32) -> Result<Vec<MemoRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT * FROM memos WHERE status='active' AND COALESCE(snoozed_until, remind_at, due_at) IS NOT NULL
             AND COALESCE(snoozed_until, remind_at, due_at) <= ?
             AND (last_triggered_at IS NULL OR last_triggered_at < COALESCE(snoozed_until, remind_at, due_at))
             ORDER BY COALESCE(snoozed_until, remind_at, due_at), id LIMIT ?",
        ).bind(before).bind(i64::from(limit.clamp(1, 200))).fetch_all(&self.pool).await?;
        rows.iter().map(memo_from_row).collect()
    }

    pub async fn next_memo_wake(&self, after: i64) -> Result<Option<MemoRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT * FROM memos WHERE status='active'
             AND COALESCE(snoozed_until, remind_at, due_at) IS NOT NULL
             AND COALESCE(snoozed_until, remind_at, due_at) >= ?
             AND (last_triggered_at IS NULL OR last_triggered_at < COALESCE(snoozed_until, remind_at, due_at))
             ORDER BY COALESCE(snoozed_until, remind_at, due_at), id LIMIT 1",
        )
        .bind(after)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(memo_from_row).transpose()
    }

    pub async fn mark_memo_triggered(&self, id: i64) -> Result<MemoRecord, StoreError> {
        sqlx::query(
            "UPDATE memos SET last_triggered_at=?, snoozed_until=NULL, updated_at=? WHERE id=?",
        )
        .bind(now_ms())
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_memo(id).await
    }

    pub async fn create_memory(
        &self,
        content: &str,
        kind: &str,
        scope_type: &str,
        scope_key: &str,
        session_id: &str,
        metadata: Value,
    ) -> Result<MemoryRecord, StoreError> {
        let content = content.trim();
        if content.is_empty() {
            return Err(StoreError::InvalidValue(
                "memory content cannot be empty".to_owned(),
            ));
        }
        let now = now_ms();
        let result = sqlx::query("INSERT INTO memories(content, kind, scope_type, scope_key, source_session_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(content).bind(kind).bind(scope_type).bind(scope_key).bind(session_id)
            .bind(serde_json::to_string(&metadata)?).bind(now).bind(now).execute(&self.pool).await?;
        self.get_memory(result.last_insert_rowid()).await
    }

    pub async fn get_memory(&self, id: i64) -> Result<MemoryRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM memories WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await?;
        memory_from_row(&row)
    }

    pub async fn search_memories(
        &self,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MemoryRecord>, StoreError> {
        let rows = if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            sqlx::query("SELECT * FROM memories WHERE content LIKE ? ORDER BY updated_at DESC, id DESC LIMIT ?")
                .bind(format!("%{}%", query.trim())).bind(i64::from(limit.clamp(1, 100))).fetch_all(&self.pool).await?
        } else {
            sqlx::query("SELECT * FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?")
                .bind(i64::from(limit.clamp(1, 100)))
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(memory_from_row).collect()
    }

    pub async fn search_memories_in_scope(
        &self,
        scope_type: &str,
        scope_key: &str,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MemoryRecord>, StoreError> {
        let rows = if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            sqlx::query(
                "SELECT * FROM memories WHERE scope_type=? AND scope_key=? AND content LIKE ? ORDER BY updated_at DESC, id DESC LIMIT ?",
            )
            .bind(scope_type)
            .bind(scope_key)
            .bind(format!("%{}%", query.trim()))
            .bind(i64::from(limit.clamp(1, 100)))
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM memories WHERE scope_type=? AND scope_key=? ORDER BY updated_at DESC, id DESC LIMIT ?",
            )
            .bind(scope_type)
            .bind(scope_key)
            .bind(i64::from(limit.clamp(1, 100)))
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(memory_from_row).collect()
    }

    pub async fn update_memory(
        &self,
        id: i64,
        content: &str,
        kind: Option<&str>,
    ) -> Result<MemoryRecord, StoreError> {
        if content.trim().is_empty() {
            return Err(StoreError::InvalidValue(
                "memory content cannot be empty".to_owned(),
            ));
        }
        sqlx::query(
            "UPDATE memories SET content=?, kind=COALESCE(?, kind), updated_at=? WHERE id=?",
        )
        .bind(content.trim())
        .bind(kind)
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_memory(id).await
    }

    pub async fn delete_memory(&self, id: i64) -> Result<(), StoreError> {
        sqlx::query("DELETE FROM memories WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn plan_operation(
        &self,
        operation_id: OperationId,
        session_id: SessionId,
        turn_id: TurnId,
        tool_call_id: &str,
        tool_name: &str,
        capability: &str,
        resource: &str,
        request: Value,
    ) -> Result<OperationJournalRecord, StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT OR IGNORE INTO operation_journal(
                operation_id, session_id, turn_id, tool_call_id, tool_name, capability,
                resource, state, request_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)",
        )
        .bind(operation_id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(tool_call_id)
        .bind(tool_name)
        .bind(capability)
        .bind(resource)
        .bind(serde_json::to_string(&request)?)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_operation(operation_id).await
    }

    pub async fn get_operation(
        &self,
        operation_id: OperationId,
    ) -> Result<OperationJournalRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM operation_journal WHERE operation_id=?")
            .bind(operation_id.to_string())
            .fetch_one(&self.pool)
            .await?;
        operation_journal_from_row(&row)
    }

    pub async fn list_operations(
        &self,
        session_id: Option<SessionId>,
        state: Option<&str>,
        limit: u32,
    ) -> Result<Vec<OperationJournalRecord>, StoreError> {
        let limit = i64::from(limit.clamp(1, 200));
        let rows = match (session_id, state) {
            (Some(session_id), Some(state)) => {
                sqlx::query("SELECT * FROM operation_journal WHERE session_id=? AND state=? ORDER BY updated_at DESC LIMIT ?")
                    .bind(session_id.to_string()).bind(state).bind(limit).fetch_all(&self.pool).await?
            }
            (Some(session_id), None) => {
                sqlx::query("SELECT * FROM operation_journal WHERE session_id=? ORDER BY updated_at DESC LIMIT ?")
                    .bind(session_id.to_string()).bind(limit).fetch_all(&self.pool).await?
            }
            (None, Some(state)) => {
                sqlx::query("SELECT * FROM operation_journal WHERE state=? ORDER BY updated_at DESC LIMIT ?")
                    .bind(state).bind(limit).fetch_all(&self.pool).await?
            }
            (None, None) => {
                sqlx::query("SELECT * FROM operation_journal ORDER BY updated_at DESC LIMIT ?")
                    .bind(limit).fetch_all(&self.pool).await?
            }
        };
        rows.iter().map(operation_journal_from_row).collect()
    }

    pub async fn resolve_unknown_operation(
        &self,
        operation_id: OperationId,
        decision: &str,
    ) -> Result<OperationJournalRecord, StoreError> {
        if !matches!(decision, "retry" | "abandon") {
            return Err(StoreError::InvalidValue(
                "operation decision must be retry or abandon".to_owned(),
            ));
        }
        let error = json!({"code":"user_resolved_unknown","decision":decision});
        let result = sqlx::query(
            "UPDATE operation_journal SET state='failed', error_json=?, updated_at=?
             WHERE operation_id=? AND state='unknown'",
        )
        .bind(serde_json::to_string(&error)?)
        .bind(now_ms())
        .bind(operation_id.to_string())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let current = self.get_operation(operation_id).await?;
            if current.state != "failed" {
                return Err(StoreError::InvalidValue(format!(
                    "operation is not awaiting review: {}",
                    current.state
                )));
            }
        }
        self.get_operation(operation_id).await
    }

    pub async fn transition_operation(
        &self,
        operation_id: OperationId,
        state: &str,
        result: Option<Value>,
        error: Option<Value>,
    ) -> Result<OperationJournalRecord, StoreError> {
        if !matches!(
            state,
            "planned" | "authorized" | "started" | "committed" | "failed" | "unknown"
        ) {
            return Err(StoreError::InvalidValue(format!(
                "invalid operation state: {state}"
            )));
        }
        sqlx::query(
            "UPDATE operation_journal SET state=?, result_json=COALESCE(?, result_json),
             error_json=?, updated_at=? WHERE operation_id=?",
        )
        .bind(state)
        .bind(
            result
                .map(|value| serde_json::to_string(&value))
                .transpose()?,
        )
        .bind(
            error
                .map(|value| serde_json::to_string(&value))
                .transpose()?,
        )
        .bind(now_ms())
        .bind(operation_id.to_string())
        .execute(&self.pool)
        .await?;
        self.get_operation(operation_id).await
    }

    pub async fn recover_started_operations(&self) -> Result<u64, StoreError> {
        Ok(sqlx::query(
            "UPDATE operation_journal SET state='unknown',
             error_json=?,
             updated_at=? WHERE state='started'",
        )
        .bind(
            r#"{"code":"server_restarted","message":"operation outcome is unknown after restart"}"#,
        )
        .bind(now_ms())
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    /// The local Agent Server is the sole durable-job claimant. On process
    /// restart no previous claimant can still be alive, so leases can be
    /// released immediately instead of stalling recovery for their full TTL.
    pub async fn recover_claimed_jobs(&self) -> Result<u64, StoreError> {
        let now = now_ms();
        Ok(sqlx::query(
            "UPDATE jobs
             SET state = 'scheduled', due_at = MIN(due_at, ?), lease_until = NULL,
                 updated_at = ?
             WHERE state = 'claimed'",
        )
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    /// Requeue handoffs failed by the retired process-global Core credential
    /// path. The predicate is intentionally exact so genuine model, Core, or
    /// transaction failures remain terminal and visible to the user.
    pub async fn recover_legacy_credential_blocked_assistant_handoffs(
        &self,
    ) -> Result<u64, StoreError> {
        let now = now_ms();
        Ok(sqlx::query(
            "UPDATE jobs
             SET state = 'scheduled', due_at = ?, attempts = 0,
                 lease_until = NULL, last_error = NULL, updated_at = ?
             WHERE kind = 'assistant.handoff' AND state = 'failed'
               AND last_error IN (
                   'assistant handoff requires MON_CORE_BASE_URL',
                   'assistant handoff requires MON_CORE_TOKEN'
               )",
        )
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    pub async fn schedule_job(
        &self,
        kind: &str,
        session_id: Option<SessionId>,
        due_at: i64,
        payload: Value,
        idempotency_key: &str,
    ) -> Result<JobRecord, StoreError> {
        let id = Uuid::now_v7();
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("INSERT INTO jobs(id, kind, session_id, due_at, payload_json, state, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET due_at=excluded.due_at, payload_json=excluded.payload_json, state='scheduled', updated_at=excluded.updated_at WHERE jobs.state IN ('scheduled', 'failed')")
            .bind(id.to_string()).bind(kind).bind(session_id.map(|value| value.to_string())).bind(due_at)
            .bind(serde_json::to_string(&payload)?).bind(idempotency_key).bind(now).bind(now).execute(&mut *transaction).await?;
        if kind == "self_awake"
            && let Some(session_id) = session_id
        {
            let row = sqlx::query("SELECT id FROM jobs WHERE idempotency_key=?")
                .bind(idempotency_key)
                .fetch_one(&mut *transaction)
                .await?;
            let persisted_job_id = row.try_get::<String, _>("id")?;
            let schema_version = payload
                .get("schemaVersion")
                .or_else(|| payload.get("schema_version"))
                .and_then(Value::as_str)
                .unwrap_or("self-awake.v1");
            let event_id = payload
                .get("eventId")
                .or_else(|| payload.get("event_id"))
                .and_then(Value::as_str)
                .unwrap_or(idempotency_key);
            let author = payload
                .get("authorSnapshot")
                .or_else(|| payload.get("author_snapshot"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            sqlx::query(
                "INSERT OR IGNORE INTO self_awake_runs(
                    id, job_id, session_id, schema_version, event_id, idempotency_key,
                    status, request_json, author_snapshot_json, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
            )
            .bind(Uuid::now_v7().to_string())
            .bind(persisted_job_id)
            .bind(session_id.to_string())
            .bind(schema_version)
            .bind(event_id)
            .bind(idempotency_key)
            .bind(serde_json::to_string(&payload)?)
            .bind(serde_json::to_string(&author)?)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.get_job_by_key(idempotency_key).await
    }

    /// Persist one assistant handoff request and its audit event together.
    ///
    /// A root turn may request at most one handoff. Retrying the same request
    /// returns the existing durable job without emitting a duplicate event;
    /// trying to change the target under the same idempotency key is rejected.
    pub async fn schedule_assistant_handoff(
        &self,
        session_id: SessionId,
        source_turn_id: TurnId,
        payload: Value,
        idempotency_key: &str,
    ) -> Result<JobRecord, StoreError> {
        let id = Uuid::now_v7();
        let now = now_ms();
        let session_key = session_id.to_string();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let inserted = sqlx::query(
            "INSERT INTO jobs(
                id, kind, session_id, due_at, payload_json, state,
                idempotency_key, created_at, updated_at
             ) VALUES (?, 'assistant.handoff', ?, ?, ?, 'scheduled', ?, ?, ?)
             ON CONFLICT(idempotency_key) DO NOTHING",
        )
        .bind(id.to_string())
        .bind(&session_key)
        .bind(now)
        .bind(serde_json::to_string(&payload)?)
        .bind(idempotency_key)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1;
        let row = sqlx::query(
            "SELECT id, kind, session_id, payload_json
             FROM jobs WHERE idempotency_key = ?",
        )
        .bind(idempotency_key)
        .fetch_one(&mut *transaction)
        .await?;
        let persisted_id = Uuid::parse_str(&row.try_get::<String, _>("id")?)?;
        let persisted_kind = row.try_get::<String, _>("kind")?;
        let persisted_session_id = row.try_get::<Option<String>, _>("session_id")?;
        let persisted_payload =
            serde_json::from_str::<Value>(&row.try_get::<String, _>("payload_json")?)?;
        if persisted_kind != "assistant.handoff"
            || persisted_session_id.as_deref() != Some(session_key.as_str())
            || persisted_payload.get("assistantId") != payload.get("assistantId")
        {
            return Err(StoreError::InvalidValue(
                "a different assistant handoff is already scheduled for this root turn".to_owned(),
            ));
        }
        let event = if inserted {
            Some(
                append_event_tx(
                    &mut transaction,
                    session_id,
                    Some(source_turn_id),
                    "session.assistant_handoff.requested",
                    json!({
                        "jobId":persisted_id,
                        "assistantId":payload.get("assistantId"),
                        "participant":payload.get("participant"),
                        "effectiveFrom":"next_root_run",
                    }),
                )
                .await?,
            )
        } else {
            None
        };
        transaction.commit().await?;
        if let Some(event) = event {
            let _ = self.events.send(event);
        }
        self.get_job_by_key(idempotency_key).await
    }

    pub async fn claim_due_jobs(
        &self,
        limit: u32,
        lease_ms: i64,
    ) -> Result<Vec<JobRecord>, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows = sqlx::query("SELECT id FROM jobs WHERE (state='scheduled' OR (state='claimed' AND lease_until < ?)) AND due_at <= ? ORDER BY due_at, id LIMIT ?")
            .bind(now).bind(now).bind(i64::from(limit.clamp(1, 100))).fetch_all(&mut *transaction).await?;
        let ids = rows
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        for id in &ids {
            sqlx::query("UPDATE jobs SET state='claimed', attempts=attempts+1, lease_until=?, updated_at=? WHERE id=?")
                .bind(now.saturating_add(lease_ms)).bind(now).bind(id).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        let mut jobs = Vec::with_capacity(ids.len());
        for id in ids {
            jobs.push(self.get_job(Uuid::parse_str(&id)?).await?);
        }
        Ok(jobs)
    }

    pub async fn complete_job(&self, id: Uuid) -> Result<(), StoreError> {
        sqlx::query("UPDATE jobs SET state='completed', lease_until=NULL, updated_at=? WHERE id=? AND state='claimed'")
            .bind(now_ms()).bind(id.to_string()).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn start_self_awake_run(
        &self,
        job: &JobRecord,
        schema_version: &str,
        event_id: &str,
        request: Value,
        author_snapshot: Value,
    ) -> Result<SelfAwakeRunRecord, StoreError> {
        let session_id = job
            .session_id
            .ok_or_else(|| StoreError::InvalidValue("self-awake job has no session".to_owned()))?;
        let now = now_ms();
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO self_awake_runs(
                id, job_id, session_id, schema_version, event_id, idempotency_key, status,
                request_json, author_snapshot_json, attempts, started_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, 1, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
                status=CASE WHEN self_awake_runs.status='completed' THEN 'completed' ELSE 'running' END,
                request_json=excluded.request_json,
                author_snapshot_json=excluded.author_snapshot_json,
                attempts=CASE WHEN self_awake_runs.status='completed' THEN self_awake_runs.attempts ELSE self_awake_runs.attempts+1 END,
                started_at=CASE WHEN self_awake_runs.status='completed' THEN self_awake_runs.started_at ELSE excluded.started_at END,
                last_error=CASE WHEN self_awake_runs.status='completed' THEN self_awake_runs.last_error ELSE NULL END,
                updated_at=excluded.updated_at",
        )
        .bind(id.to_string())
        .bind(job.id.to_string())
        .bind(session_id.to_string())
        .bind(schema_version)
        .bind(event_id)
        .bind(&job.idempotency_key)
        .bind(serde_json::to_string(&request)?)
        .bind(serde_json::to_string(&author_snapshot)?)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_self_awake_run_by_job(job.id).await
    }

    pub async fn get_self_awake_run_by_job(
        &self,
        job_id: Uuid,
    ) -> Result<SelfAwakeRunRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM self_awake_runs WHERE job_id=?")
            .bind(job_id.to_string())
            .fetch_one(&self.pool)
            .await?;
        self_awake_run_from_row(&row)
    }

    pub async fn list_self_awake_runs(
        &self,
        offset: u32,
        limit: u32,
        query: Option<&str>,
    ) -> Result<Vec<SelfAwakeRunRecord>, StoreError> {
        let pattern = query
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{value}%"));
        let rows = sqlx::query(
            "SELECT * FROM self_awake_runs
             WHERE ? IS NULL OR status LIKE ? OR request_json LIKE ? OR COALESCE(decision_json, '') LIKE ?
             ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        )
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(i64::from(limit.clamp(1, 100)))
        .bind(i64::from(offset))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(self_awake_run_from_row).collect()
    }

    pub async fn count_self_awake_runs(&self, query: Option<&str>) -> Result<u64, StoreError> {
        let pattern = query
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{value}%"));
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM self_awake_runs
             WHERE ? IS NULL OR status LIKE ? OR request_json LIKE ? OR COALESCE(decision_json, '') LIKE ?",
        )
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .bind(pattern.as_deref())
        .fetch_one(&self.pool)
        .await?;
        Ok(u64::try_from(count).unwrap_or_default())
    }

    pub async fn list_self_awake_diaries(
        &self,
        session_id: SessionId,
        limit: u32,
    ) -> Result<Vec<SelfAwakeDiaryRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT * FROM self_awake_diaries WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
        )
        .bind(session_id.to_string())
        .bind(i64::from(limit.clamp(1, 50)))
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(self_awake_diary_from_row).collect()
    }

    pub async fn list_self_awake_diaries_for_run(
        &self,
        run_id: Uuid,
    ) -> Result<Vec<SelfAwakeDiaryRecord>, StoreError> {
        let rows =
            sqlx::query("SELECT * FROM self_awake_diaries WHERE run_id=? ORDER BY created_at, id")
                .bind(run_id.to_string())
                .fetch_all(&self.pool)
                .await?;
        rows.iter().map(self_awake_diary_from_row).collect()
    }

    /// Commit the decision, optional diary/notification intent, current job
    /// completion, and next wake in one SQLite transaction.
    #[allow(clippy::too_many_arguments)]
    pub async fn complete_self_awake_run(
        &self,
        run: &SelfAwakeRunRecord,
        decision: Value,
        diary: Option<Value>,
        notification: Option<Value>,
        next_wake: Option<(i64, Value, String)>,
    ) -> Result<Option<JobRecord>, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "UPDATE self_awake_runs SET status='completed', decision_json=?, completed_at=?, updated_at=?
             WHERE id=? AND status!='completed'",
        )
        .bind(serde_json::to_string(&decision)?)
        .bind(now)
        .bind(now)
        .bind(run.id.to_string())
        .execute(&mut *transaction)
        .await?;

        if let Some(diary) = diary {
            let title = diary
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("自醒日记");
            let content = diary.get("content").and_then(Value::as_str).unwrap_or("");
            let mood = diary.get("mood").and_then(Value::as_str).unwrap_or("");
            let assistant_id = run
                .author_snapshot
                .get("assistantId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let character_id = run
                .author_snapshot
                .get("characterId")
                .and_then(Value::as_str)
                .unwrap_or("");
            sqlx::query(
                "INSERT OR IGNORE INTO self_awake_diaries(
                    id, run_id, session_id, assistant_id, character_id, title, content, mood, metadata_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(Uuid::now_v7().to_string())
            .bind(run.id.to_string())
            .bind(run.session_id.to_string())
            .bind(assistant_id)
            .bind(character_id)
            .bind(title.trim())
            .bind(content.trim())
            .bind(mood.trim())
            .bind(serde_json::to_string(&diary)?)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }

        if let Some(notification) = notification {
            let channel = notification
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            sqlx::query(
                "INSERT OR IGNORE INTO self_awake_notifications(
                    run_id, requested_channel, state, payload_json, created_at, updated_at
                 ) VALUES (?, ?, 'pending', ?, ?, ?)",
            )
            .bind(run.id.to_string())
            .bind(channel)
            .bind(serde_json::to_string(&notification)?)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }

        sqlx::query("UPDATE jobs SET state='completed', lease_until=NULL, updated_at=? WHERE id=?")
            .bind(now)
            .bind(run.job_id.to_string())
            .execute(&mut *transaction)
            .await?;

        let mut next_job_id = None;
        if let Some((due_at, payload, idempotency_key)) = next_wake {
            let id = Uuid::now_v7();
            sqlx::query(
                "INSERT OR IGNORE INTO jobs(
                    id, kind, session_id, due_at, payload_json, state, idempotency_key, created_at, updated_at
                 ) VALUES (?, 'self_awake', ?, ?, ?, 'scheduled', ?, ?, ?)",
            )
            .bind(id.to_string())
            .bind(run.session_id.to_string())
            .bind(due_at)
            .bind(serde_json::to_string(&payload)?)
            .bind(&idempotency_key)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
            let row = sqlx::query("SELECT id FROM jobs WHERE idempotency_key=?")
                .bind(&idempotency_key)
                .fetch_one(&mut *transaction)
                .await?;
            let persisted_job_id = row.try_get::<String, _>("id")?;
            next_job_id = Some(Uuid::parse_str(&persisted_job_id)?);
            let schema_version = payload
                .get("schemaVersion")
                .or_else(|| payload.get("schema_version"))
                .and_then(Value::as_str)
                .unwrap_or("self-awake.v1");
            let event_id = payload
                .get("eventId")
                .or_else(|| payload.get("event_id"))
                .and_then(Value::as_str)
                .unwrap_or(&idempotency_key);
            sqlx::query(
                "INSERT OR IGNORE INTO self_awake_runs(
                    id, job_id, session_id, schema_version, event_id, idempotency_key,
                    status, request_json, author_snapshot_json, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '{}', ?, ?)",
            )
            .bind(Uuid::now_v7().to_string())
            .bind(&persisted_job_id)
            .bind(run.session_id.to_string())
            .bind(schema_version)
            .bind(event_id)
            .bind(&idempotency_key)
            .bind(serde_json::to_string(&payload)?)
            .bind(now)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        if let Some(id) = next_job_id {
            Ok(Some(self.get_job(id).await?))
        } else {
            Ok(None)
        }
    }

    pub async fn fail_self_awake_run(&self, job_id: Uuid, error: &str) -> Result<(), StoreError> {
        sqlx::query(
            "UPDATE self_awake_runs SET status='failed', last_error=?, completed_at=?, updated_at=?
             WHERE job_id=? AND status!='completed'",
        )
        .bind(error)
        .bind(now_ms())
        .bind(now_ms())
        .bind(job_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_self_awake_notification(
        &self,
        run_id: Uuid,
        state: &str,
        result: Option<Value>,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        if !matches!(state, "pending" | "delivered" | "failed" | "suppressed") {
            return Err(StoreError::InvalidValue(format!(
                "invalid self-awake notification state: {state}"
            )));
        }
        sqlx::query(
            "UPDATE self_awake_notifications SET state=?, result_json=?, attempts=attempts+1,
             last_error=?, updated_at=? WHERE run_id=? AND state!='delivered'",
        )
        .bind(state)
        .bind(
            result
                .map(|value| serde_json::to_string(&value))
                .transpose()?,
        )
        .bind(error)
        .bind(now_ms())
        .bind(run_id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fail_job(
        &self,
        id: Uuid,
        error: &str,
        retry_at: Option<i64>,
    ) -> Result<(), StoreError> {
        if let Some(retry_at) = retry_at {
            sqlx::query("UPDATE jobs SET state='scheduled', due_at=?, lease_until=NULL, last_error=?, updated_at=? WHERE id=? AND state='claimed'")
                .bind(retry_at).bind(error).bind(now_ms()).bind(id.to_string()).execute(&self.pool).await?;
        } else {
            sqlx::query("UPDATE jobs SET state='failed', lease_until=NULL, last_error=?, updated_at=? WHERE id=? AND state='claimed'")
                .bind(error).bind(now_ms()).bind(id.to_string()).execute(&self.pool).await?;
        }
        Ok(())
    }

    pub async fn get_job(&self, id: Uuid) -> Result<JobRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM jobs WHERE id=?")
            .bind(id.to_string())
            .fetch_one(&self.pool)
            .await?;
        job_from_row(&row)
    }

    pub async fn list_jobs(
        &self,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<Vec<JobRecord>, StoreError> {
        let rows = if let Some(kind) = kind {
            sqlx::query("SELECT * FROM jobs WHERE kind=? ORDER BY created_at DESC LIMIT ?")
                .bind(kind)
                .bind(i64::from(limit.clamp(1, 500)))
                .fetch_all(&self.pool)
                .await?
        } else {
            sqlx::query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
                .bind(i64::from(limit.clamp(1, 500)))
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(job_from_row).collect()
    }

    async fn get_job_by_key(&self, key: &str) -> Result<JobRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM jobs WHERE idempotency_key=?")
            .bind(key)
            .fetch_one(&self.pool)
            .await?;
        job_from_row(&row)
    }

    pub async fn register_connector(
        &self,
        connector_key: &str,
        identity_key: &str,
        display_name: &str,
        desired_state: &str,
        settings: Value,
    ) -> Result<ConnectorRecord, StoreError> {
        if connector_key.trim().is_empty() || identity_key.trim().is_empty() {
            return Err(StoreError::InvalidValue(
                "connector key and identity are required".to_owned(),
            ));
        }
        if !matches!(desired_state, "connected" | "disconnected") {
            return Err(StoreError::InvalidValue(
                "invalid connector desired state".to_owned(),
            ));
        }
        let id = Uuid::now_v7();
        let now = now_ms();
        sqlx::query("INSERT INTO connectors(id, connector_key, identity_key, display_name, desired_state, runtime_state, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'offline', ?, ?, ?)")
            .bind(id.to_string()).bind(connector_key).bind(identity_key).bind(display_name).bind(desired_state)
            .bind(serde_json::to_string(&settings)?).bind(now).bind(now).execute(&self.pool).await?;
        self.get_connector(id).await
    }

    pub async fn get_connector(&self, id: Uuid) -> Result<ConnectorRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM connectors WHERE id=?")
            .bind(id.to_string())
            .fetch_one(&self.pool)
            .await?;
        connector_from_row(&row)
    }

    pub async fn list_connectors(&self) -> Result<Vec<ConnectorRecord>, StoreError> {
        let rows = sqlx::query("SELECT * FROM connectors ORDER BY created_at, id")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(connector_from_row).collect()
    }

    pub async fn update_connector(
        &self,
        id: Uuid,
        patch: Value,
    ) -> Result<ConnectorRecord, StoreError> {
        let current = self.get_connector(id).await?;
        let desired_state = string_patch(&patch, "desiredState").unwrap_or(current.desired_state);
        if !matches!(desired_state.as_str(), "connected" | "disconnected") {
            return Err(StoreError::InvalidValue(
                "invalid connector desired state".to_owned(),
            ));
        }
        let display_name = string_patch(&patch, "displayName").unwrap_or(current.display_name);
        let settings = patch.get("settings").cloned().unwrap_or(current.settings);
        sqlx::query("UPDATE connectors SET display_name=?, desired_state=?, settings_json=?, updated_at=? WHERE id=?")
            .bind(display_name).bind(desired_state).bind(serde_json::to_string(&settings)?).bind(now_ms()).bind(id.to_string()).execute(&self.pool).await?;
        self.get_connector(id).await
    }

    pub async fn report_connector_state(
        &self,
        id: Uuid,
        state: &str,
        error: Option<&str>,
    ) -> Result<ConnectorRecord, StoreError> {
        if !matches!(
            state,
            "offline" | "connecting" | "connected" | "reconnecting" | "error"
        ) {
            return Err(StoreError::InvalidValue(
                "invalid connector runtime state".to_owned(),
            ));
        }
        sqlx::query("UPDATE connectors SET runtime_state=?, last_error=?, updated_at=? WHERE id=?")
            .bind(state)
            .bind(error)
            .bind(now_ms())
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        self.get_connector(id).await
    }

    pub async fn publish_connector_event(
        &self,
        connector_id: Uuid,
        external_id: &str,
        event_type: &str,
        payload: Value,
    ) -> Result<ConnectorEventRecord, StoreError> {
        let connector = self.get_connector(connector_id).await?;
        let id = Uuid::now_v7();
        let now = now_ms();
        sqlx::query("INSERT INTO connector_events(id, connector_id, external_id, event_type, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(connector_id, external_id) DO NOTHING")
            .bind(id.to_string()).bind(connector_id.to_string()).bind(external_id).bind(event_type)
            .bind(serde_json::to_string(&payload)?).bind(now).bind(now).execute(&self.pool).await?;
        let row =
            sqlx::query("SELECT * FROM connector_events WHERE connector_id=? AND external_id=?")
                .bind(connector_id.to_string())
                .bind(external_id)
                .fetch_one(&self.pool)
                .await?;
        let event = connector_event_from_row(&row)?;
        let self_awake_enabled = connector
            .settings
            .get("selfAwakeOnEvent")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let bound_session = connector
            .settings
            .get("boundSessionId")
            .or_else(|| connector.settings.get("sessionId"))
            .or_else(|| connector.settings.get("session_id"))
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<SessionId>().ok());
        if self_awake_enabled && let Some(session_id) = bound_session {
            let history = payload
                .get("conversationHistory")
                .cloned()
                .unwrap_or_else(|| json!([]));
            self.schedule_job(
                "self_awake",
                Some(session_id),
                now,
                json!({
                    "schemaVersion":"self-awake.v1",
                    "eventId":event.id,
                    "trigger":{
                        "type":"connector_event",
                        "connectorId":connector_id,
                        "connectorKey":connector.connector_key,
                        "eventId":event.id,
                        "externalId":external_id,
                        "eventType":event_type,
                        "payload":payload,
                    },
                    "conversationHistory":history,
                }),
                &format!("self-awake:connector:{connector_id}:{external_id}"),
            )
            .await?;
        }
        Ok(event)
    }

    pub async fn claim_connector_events(
        &self,
        connector_id: Uuid,
        limit: u32,
        lease_ms: i64,
    ) -> Result<Vec<ConnectorEventRecord>, StoreError> {
        let now = now_ms();
        let operation_id = Uuid::now_v7();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows = sqlx::query("SELECT id FROM connector_events WHERE connector_id=? AND (status='pending' OR (status='claimed' AND lease_until < ?)) ORDER BY created_at, id LIMIT ?")
            .bind(connector_id.to_string()).bind(now).bind(i64::from(limit.clamp(1, 100))).fetch_all(&mut *transaction).await?;
        let ids = rows
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        for id in &ids {
            sqlx::query("UPDATE connector_events SET status='claimed', operation_id=?, lease_until=?, updated_at=? WHERE id=?")
            .bind(operation_id.to_string()).bind(now.saturating_add(lease_ms)).bind(now).bind(id).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        let mut events = Vec::with_capacity(ids.len());
        for id in ids {
            let row = sqlx::query("SELECT * FROM connector_events WHERE id=?")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
            events.push(connector_event_from_row(&row)?);
        }
        Ok(events)
    }

    pub async fn finish_connector_events(
        &self,
        ids: &[Uuid],
        retry: bool,
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for id in ids {
            sqlx::query("UPDATE connector_events SET status=?, operation_id=NULL, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed'")
            .bind(if retry { "pending" } else { "completed" }).bind(now_ms()).bind(id.to_string()).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn create_media_request(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        kind: &str,
        request: Value,
    ) -> Result<MediaRequestRecord, StoreError> {
        if !matches!(kind, "screen" | "camera") {
            return Err(StoreError::InvalidValue(
                "invalid media request kind".to_owned(),
            ));
        }
        let id = Uuid::now_v7();
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        sqlx::query("INSERT INTO media_requests(id,session_id,turn_id,kind,state,request_json,created_at) VALUES (?,?,?,?,'pending',?,?)")
            .bind(id.to_string()).bind(session_id.to_string()).bind(turn_id.to_string()).bind(kind)
            .bind(serde_json::to_string(&request)?).bind(now).execute(&mut *transaction).await?;
        let record = MediaRequestRecord {
            id,
            session_id,
            turn_id,
            kind: kind.to_owned(),
            state: "pending".to_owned(),
            request,
            result: None,
            error: None,
            created_at: now,
            resolved_at: None,
        };
        let event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "media.requested",
            serde_json::to_value(&record)?,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn list_pending_media_requests(
        &self,
        kind: Option<&str>,
    ) -> Result<Vec<MediaRequestRecord>, StoreError> {
        let rows = if let Some(kind) = kind {
            sqlx::query("SELECT * FROM media_requests WHERE state='pending' AND kind=? ORDER BY created_at,id").bind(kind).fetch_all(&self.pool).await?
        } else {
            sqlx::query("SELECT * FROM media_requests WHERE state='pending' ORDER BY created_at,id")
                .fetch_all(&self.pool)
                .await?
        };
        rows.iter().map(media_request_from_row).collect()
    }

    pub async fn get_media_request(&self, id: Uuid) -> Result<MediaRequestRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM media_requests WHERE id=?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::InvalidValue("media request does not exist".to_owned()))?;
        media_request_from_row(&row)
    }

    pub async fn resolve_media_request(
        &self,
        id: Uuid,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<MediaRequestRecord, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed=sqlx::query("UPDATE media_requests SET state=?,result_json=?,error=?,resolved_at=? WHERE id=? AND state='pending'")
            .bind(if result.is_some(){"answered"}else{"rejected"}).bind(result.as_ref().map(serde_json::to_string).transpose()?)
            .bind(&error).bind(now).bind(id.to_string()).execute(&mut *transaction).await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::InvalidValue(
                "media request is not pending".to_owned(),
            ));
        }
        let row = sqlx::query("SELECT * FROM media_requests WHERE id=?")
            .bind(id.to_string())
            .fetch_one(&mut *transaction)
            .await?;
        let record = media_request_from_row(&row)?;
        let event = append_event_tx(
            &mut transaction,
            record.session_id,
            Some(record.turn_id),
            "media.resolved",
            serde_json::to_value(&record)?,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }
}

fn validate_memo(input: &MemoInput) -> Result<(), StoreError> {
    if input.title.trim().is_empty() {
        return Err(StoreError::InvalidValue(
            "memo title cannot be empty".to_owned(),
        ));
    }
    if !matches!(input.kind.as_str(), "note" | "reminder" | "todo") {
        return Err(StoreError::InvalidValue("invalid memo kind".to_owned()));
    }
    if !matches!(
        input.status.as_str(),
        "active" | "done" | "archived" | "cancelled"
    ) {
        return Err(StoreError::InvalidValue("invalid memo status".to_owned()));
    }
    if !matches!(input.priority.as_str(), "low" | "normal" | "high") {
        return Err(StoreError::InvalidValue("invalid memo priority".to_owned()));
    }
    Ok(())
}

pub(crate) fn sanitize_model_runtime_info(value: &Value) -> Value {
    let mut sanitized = serde_json::Map::new();
    for key in [
        "id",
        "provider",
        "api",
        "baseUrl",
        "contextWindow",
        "maxTokens",
        "source",
        "aiEntityId",
        "label",
        "available",
        "error",
    ] {
        if let Some(value) = value.get(key) {
            sanitized.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(sanitized)
}

fn string_patch(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn optional_i64_patch(value: &Value, key: &str, current: Option<i64>) -> Option<i64> {
    match value.get(key) {
        Some(Value::Null) => None,
        Some(value) => value.as_i64().or(current),
        None => current,
    }
}

fn memo_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<MemoRecord, StoreError> {
    Ok(MemoRecord {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        content: row.try_get("content")?,
        kind: row.try_get("kind")?,
        status: row.try_get("status")?,
        priority: row.try_get("priority")?,
        remind_at: row.try_get("remind_at")?,
        due_at: row.try_get("due_at")?,
        repeat_rule: row.try_get("repeat_rule")?,
        source: row.try_get("source")?,
        related_session_id: row.try_get("related_session_id")?,
        last_triggered_at: row.try_get("last_triggered_at")?,
        snoozed_until: row.try_get("snoozed_until")?,
        completed_at: row.try_get("completed_at")?,
        metadata: serde_json::from_str(&row.try_get::<String, _>("metadata_json")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn memory_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<MemoryRecord, StoreError> {
    Ok(MemoryRecord {
        id: row.try_get("id")?,
        content: row.try_get("content")?,
        kind: row.try_get("kind")?,
        scope_type: row.try_get("scope_type")?,
        scope_key: row.try_get("scope_key")?,
        source_session_id: row.try_get("source_session_id")?,
        metadata: serde_json::from_str(&row.try_get::<String, _>("metadata_json")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn session_model_binding_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SessionModelBindingRecord, StoreError> {
    Ok(SessionModelBindingRecord {
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        assistant_id: row.try_get("assistant_id")?,
        ai_entity_id: row.try_get("ai_entity_id")?,
        vision_ai_entity_id: row.try_get("vision_ai_entity_id")?,
        runtime_info: serde_json::from_str(&row.try_get::<String, _>("runtime_info_json")?)?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn session_actor_model_binding_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SessionActorModelBindingRecord, StoreError> {
    Ok(SessionActorModelBindingRecord {
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        assistant_id: row.try_get("assistant_id")?,
        ai_entity_id: row.try_get("ai_entity_id")?,
        vision_ai_entity_id: row.try_get("vision_ai_entity_id")?,
        runtime_info: serde_json::from_str(&row.try_get::<String, _>("runtime_info_json")?)?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn core_session_identity_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<CoreSessionIdentityRecord, StoreError> {
    Ok(CoreSessionIdentityRecord {
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        core_base_url: row.try_get("core_base_url")?,
        principal_key: row.try_get("principal_key")?,
        credential_ref: row.try_get("credential_ref")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn core_sync_outbox_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<CoreSyncOutboxRecord, StoreError> {
    Ok(CoreSyncOutboxRecord {
        id: row.try_get("id")?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        credential_ref: row.try_get("credential_ref")?,
        kind: row.try_get("kind")?,
        dedupe_key: row.try_get("dedupe_key")?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        state: row.try_get("state")?,
        attempts: row.try_get("attempts")?,
        next_attempt_at: row.try_get("next_attempt_at")?,
        claimed_at: row.try_get("claimed_at")?,
        last_error: row.try_get("last_error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn job_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<JobRecord, StoreError> {
    Ok(JobRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        kind: row.try_get("kind")?,
        session_id: row
            .try_get::<Option<String>, _>("session_id")?
            .map(|value| value.parse())
            .transpose()?,
        due_at: row.try_get("due_at")?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        state: row.try_get("state")?,
        attempts: row.try_get("attempts")?,
        lease_until: row.try_get("lease_until")?,
        idempotency_key: row.try_get("idempotency_key")?,
        last_error: row.try_get("last_error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn self_awake_run_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SelfAwakeRunRecord, StoreError> {
    Ok(SelfAwakeRunRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        job_id: Uuid::parse_str(&row.try_get::<String, _>("job_id")?)?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        schema_version: row.try_get("schema_version")?,
        event_id: row.try_get("event_id")?,
        idempotency_key: row.try_get("idempotency_key")?,
        status: row.try_get("status")?,
        request: serde_json::from_str(&row.try_get::<String, _>("request_json")?)?,
        decision: row
            .try_get::<Option<String>, _>("decision_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        author_snapshot: serde_json::from_str(&row.try_get::<String, _>("author_snapshot_json")?)?,
        attempts: row.try_get("attempts")?,
        last_error: row.try_get("last_error")?,
        started_at: row.try_get("started_at")?,
        completed_at: row.try_get("completed_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn self_awake_diary_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<SelfAwakeDiaryRecord, StoreError> {
    Ok(SelfAwakeDiaryRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        run_id: Uuid::parse_str(&row.try_get::<String, _>("run_id")?)?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        assistant_id: row.try_get("assistant_id")?,
        character_id: row.try_get("character_id")?,
        title: row.try_get("title")?,
        content: row.try_get("content")?,
        mood: row.try_get("mood")?,
        metadata: serde_json::from_str(&row.try_get::<String, _>("metadata_json")?)?,
        created_at: row.try_get("created_at")?,
    })
}

fn operation_journal_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<OperationJournalRecord, StoreError> {
    Ok(OperationJournalRecord {
        operation_id: row.try_get::<String, _>("operation_id")?.parse()?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        turn_id: row.try_get::<String, _>("turn_id")?.parse()?,
        tool_call_id: row.try_get("tool_call_id")?,
        tool_name: row.try_get("tool_name")?,
        capability: row.try_get("capability")?,
        resource: row.try_get("resource")?,
        state: row.try_get("state")?,
        request: serde_json::from_str(&row.try_get::<String, _>("request_json")?)?,
        result: row
            .try_get::<Option<String>, _>("result_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        error: row
            .try_get::<Option<String>, _>("error_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn connector_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ConnectorRecord, StoreError> {
    Ok(ConnectorRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        connector_key: row.try_get("connector_key")?,
        identity_key: row.try_get("identity_key")?,
        display_name: row.try_get("display_name")?,
        desired_state: row.try_get("desired_state")?,
        runtime_state: row.try_get("runtime_state")?,
        settings: serde_json::from_str(&row.try_get::<String, _>("settings_json")?)?,
        last_error: row.try_get("last_error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn connector_event_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<ConnectorEventRecord, StoreError> {
    Ok(ConnectorEventRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        connector_id: Uuid::parse_str(&row.try_get::<String, _>("connector_id")?)?,
        external_id: row.try_get("external_id")?,
        event_type: row.try_get("event_type")?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        status: row.try_get("status")?,
        operation_id: row
            .try_get::<Option<String>, _>("operation_id")?
            .map(|value| Uuid::parse_str(&value))
            .transpose()?,
        lease_until: row.try_get("lease_until")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn media_request_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<MediaRequestRecord, StoreError> {
    Ok(MediaRequestRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        turn_id: row.try_get::<String, _>("turn_id")?.parse()?,
        kind: row.try_get("kind")?,
        state: row.try_get("state")?,
        request: serde_json::from_str(&row.try_get::<String, _>("request_json")?)?,
        result: row
            .try_get::<Option<String>, _>("result_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}
