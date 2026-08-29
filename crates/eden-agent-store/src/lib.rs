//! Durable SQLite state for Eden Agent sessions.

mod host;
mod legacy_import;
mod plugins;
pub use host::*;
pub use legacy_import::*;
pub use plugins::*;

use eden_agent_domain::{
    AgentId, BlobId, OperationId, PermissionRequestId, QuestionRequestId, SessionId, TurnId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{
    path::Path,
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

const EVENT_BROADCAST_CAPACITY: usize = 1_024;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session does not exist: {0}")]
    SessionNotFound(SessionId),
    #[error("session is closed: {0}")]
    SessionClosed(SessionId),
    #[error("invalid persisted ID: {0}")]
    InvalidId(#[from] uuid::Error),
    #[error("permission request does not exist: {0}")]
    PermissionNotFound(PermissionRequestId),
    #[error("permission request is already resolved: {0}")]
    PermissionAlreadyResolved(PermissionRequestId),
    #[error("question request does not exist: {0}")]
    QuestionNotFound(QuestionRequestId),
    #[error("question request is already resolved: {0}")]
    QuestionAlreadyResolved(QuestionRequestId),
    #[error("blob does not exist: {0}")]
    BlobNotFound(BlobId),
    #[error("agent thread does not exist: {0}")]
    AgentNotFound(AgentId),
    #[error("agent thread is not in a mutable state: {0}")]
    AgentNotMutable(AgentId),
    #[error("invalid value: {0}")]
    InvalidValue(String),
    #[error("plugin does not exist: {0}")]
    PluginNotFound(String),
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    events: broadcast::Sender<EventRecord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStateRecord {
    pub current_path: String,
    pub pending_path: Option<String>,
    pub pending_session_id: Option<SessionId>,
    pub requested_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventPageRecord {
    pub items: Vec<EventRecord>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RuntimeMetricsSnapshot {
    pub active_sessions: i64,
    pub queued_inputs: i64,
    pub claimed_inputs: i64,
    pub active_agents: i64,
    pub scheduled_jobs: i64,
    pub claimed_jobs: i64,
    pub pending_connector_events: i64,
    pub pending_core_sync: i64,
    pub turns_started: i64,
    pub turns_completed: i64,
    pub turns_failed: i64,
    pub provider_retries: i64,
    pub tool_calls_started: i64,
    pub tool_calls_completed: i64,
    pub tool_calls_failed: i64,
    pub first_token_samples: i64,
    pub first_token_total_ms: i64,
    pub turn_duration_samples: i64,
    pub turn_duration_total_ms: i64,
    pub tool_duration_samples: i64,
    pub tool_duration_total_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: SessionId,
    pub title: String,
    pub title_source: String,
    pub status: SessionStatus,
    pub runtime_origin: SessionRuntimeOrigin,
    #[serde(default)]
    pub participants: Vec<Value>,
    #[serde(default)]
    pub environment: Value,
    #[serde(default)]
    pub context_usage: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRuntimeOrigin {
    #[default]
    Mon,
    Local,
}

impl SessionRuntimeOrigin {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mon => "mon",
            Self::Local => "local",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "local" => Self::Local,
            _ => Self::Mon,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Closed,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Closed => "closed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "closed" => Self::Closed,
            _ => Self::Active,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRecord {
    pub id: OperationId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub payload: Value,
    pub state: InputState,
    pub created_at: i64,
    pub claimed_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueuedInput {
    pub input: InputRecord,
    pub admitted_event: EventRecord,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantHandoffCommit {
    pub queued_input_resumed: bool,
    pub target_run_enqueued: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    Queued,
    Claimed,
    Completed,
    Interrupted,
}

impl InputState {
    fn parse(value: &str) -> Self {
        match value {
            "claimed" => Self::Claimed,
            "completed" => Self::Completed,
            "interrupted" => Self::Interrupted,
            _ => Self::Queued,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: Uuid,
    pub session_id: SessionId,
    pub seq: i64,
    pub turn_id: Option<TurnId>,
    pub event_type: String,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRecord {
    pub id: PermissionRequestId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub operation_id: OperationId,
    pub capability: String,
    pub resource: String,
    pub state: PermissionState,
    pub request: Value,
    pub decision: Option<Value>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Pending,
    Allowed,
    Denied,
    Expired,
}

impl PermissionState {
    fn parse(value: &str) -> Self {
        match value {
            "allowed" => Self::Allowed,
            "denied" => Self::Denied,
            "expired" => Self::Expired,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PermissionMutation {
    pub permission: PermissionRecord,
    pub event: EventRecord,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRecord {
    pub id: QuestionRequestId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub state: QuestionState,
    pub questions: Value,
    pub answers: Option<Value>,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionState {
    Pending,
    Answered,
    Rejected,
    Expired,
}

impl QuestionState {
    fn parse(value: &str) -> Self {
        match value {
            "answered" => Self::Answered,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QuestionMutation {
    pub question: QuestionRecord,
    pub event: EventRecord,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobRecord {
    pub id: BlobId,
    pub sha256: String,
    pub mime: String,
    pub byte_length: i64,
    pub storage_path: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSpeechSegmentRecord {
    pub id: i64,
    pub session_id: SessionId,
    pub external_message_id: String,
    pub external_audio_asset_id: Option<i64>,
    pub audio_blob_id: BlobId,
    pub duration_ms: Option<i64>,
    pub audio_format: String,
    pub segment_group_id: String,
    pub group_index: i64,
    pub sequence: i64,
    pub text_hash: String,
    pub text_length: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct VoiceSpeechSegmentUpsert {
    pub session_id: SessionId,
    pub external_message_id: String,
    pub external_audio_asset_id: Option<i64>,
    pub audio_blob_id: BlobId,
    pub duration_ms: Option<i64>,
    pub audio_format: String,
    pub segment_group_id: String,
    pub group_index: i64,
    pub sequence: i64,
    pub text_hash: String,
    pub text_length: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadRecord {
    pub id: AgentId,
    pub session_id: SessionId,
    pub parent_id: Option<AgentId>,
    pub agent_path: String,
    pub task_name: String,
    pub role: String,
    pub prompt: String,
    pub status: String,
    pub context: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub usage: Value,
    pub deadline_at: Option<i64>,
    pub coordination_batch_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMailboxRecord {
    pub id: Uuid,
    pub session_id: SessionId,
    pub sender_path: String,
    pub target_path: String,
    pub content: String,
    pub kind: String,
    pub trigger_turn: bool,
    pub details: Value,
    pub created_at: i64,
    pub consumed_at: Option<i64>,
}

impl Store {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let url = format!(
            "sqlite://{}",
            path.as_ref().to_string_lossy().replace('\\', "/")
        );
        let options = SqliteConnectOptions::from_str(&url)?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        // WAL allows readers to continue while one writer is active. Explicit
        // transactions use BEGIN IMMEDIATE throughout this crate so writers
        // queue before doing any reads instead of deadlocking during a deferred
        // read-to-write upgrade. Keeping several connections prevents a slow
        // background transaction from starving read-only UI requests.
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            // A burst of BEGIN IMMEDIATE writers can occupy every pooled
            // connection while SQLite serializes them. Windows filesystem
            // latency can legitimately exceed the previous five-second pool
            // deadline, so let queued runtime writes wait for the writer turn.
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        sqlx::query(
            "UPDATE operation_journal SET state='unknown', error_json=?, updated_at=?
             WHERE state='started'",
        )
        .bind(
            r#"{"code":"server_restarted","message":"operation outcome is unknown after restart"}"#,
        )
        .bind(now_ms())
        .execute(&pool)
        .await?;
        let (events, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        Ok(Self { pool, events })
    }

    pub async fn in_memory() -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Memory)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        let (events, _) = broadcast::channel(EVENT_BROADCAST_CAPACITY);
        Ok(Self { pool, events })
    }

    /// Permanently binds a database to one runtime realm.  The first bind also
    /// removes sessions belonging to the other realm (including their
    /// cascading rows).  Subsequent attempts to open the same database for a
    /// different realm fail closed instead of silently sharing state.
    pub async fn bind_runtime_origin(
        &self,
        runtime_origin: SessionRuntimeOrigin,
        allow_migration_rebind: bool,
    ) -> Result<u64, StoreError> {
        const KEY: &str = "system.runtime_origin";
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing =
            sqlx::query_scalar::<_, String>("SELECT value_json FROM app_config WHERE key=?")
                .bind(KEY)
                .fetch_optional(&mut *transaction)
                .await?;
        if let Some(existing) = existing {
            let bound: String = serde_json::from_str(&existing)?;
            if bound != runtime_origin.as_str() && !allow_migration_rebind {
                return Err(StoreError::InvalidValue(format!(
                    "database is bound to runtime origin {bound}, not {}",
                    runtime_origin.as_str()
                )));
            }
            if bound == runtime_origin.as_str() {
                transaction.commit().await?;
                return Ok(0);
            }
        }
        let removed = sqlx::query("DELETE FROM sessions WHERE runtime_origin <> ?")
            .bind(runtime_origin.as_str())
            .execute(&mut *transaction)
            .await?
            .rows_affected();
        sqlx::query("INSERT INTO app_config(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
            .bind(KEY)
            .bind(serde_json::to_string(runtime_origin.as_str())?)
            .bind(now_ms())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(removed)
    }

    pub async fn expire_pending_interactions(&self) -> Result<u64, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut count = 0;
        count += sqlx::query(
            "UPDATE permission_requests SET state='expired', resolved_at=? WHERE state='pending'",
        )
        .bind(now)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        count += sqlx::query(
            "UPDATE question_requests SET state='expired', resolved_at=? WHERE state='pending'",
        )
        .bind(now)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        count += sqlx::query("UPDATE media_requests SET state='expired', resolved_at=?, error='server restarted while request was pending' WHERE state='pending'")
            .bind(now).execute(&mut *transaction).await?.rows_affected();
        transaction.commit().await?;
        Ok(count)
    }

    #[must_use]
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn database_probe(&self) -> Result<(), StoreError> {
        let _: i64 = sqlx::query_scalar("SELECT 1").fetch_one(&self.pool).await?;
        Ok(())
    }

    pub async fn runtime_metrics_snapshot(&self) -> Result<RuntimeMetricsSnapshot, StoreError> {
        let counts = sqlx::query(
            "SELECT
                (SELECT COUNT(*) FROM sessions WHERE status='active') AS active_sessions,
                (SELECT COUNT(*) FROM session_inputs WHERE state='queued') AS queued_inputs,
                (SELECT COUNT(*) FROM session_inputs WHERE state='claimed') AS claimed_inputs,
                (SELECT COUNT(*) FROM agent_threads WHERE status IN ('queued','running')) AS active_agents,
                (SELECT COUNT(*) FROM jobs WHERE state='scheduled') AS scheduled_jobs,
                (SELECT COUNT(*) FROM jobs WHERE state='claimed') AS claimed_jobs,
                (SELECT COUNT(*) FROM connector_events WHERE status IN ('pending','claimed')) AS pending_connector_events,
                (SELECT COUNT(*) FROM core_sync_outbox WHERE state IN ('queued','claimed')) AS pending_core_sync,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='turns_started_total'),0) AS turns_started,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='turns_completed_total'),0) AS turns_completed,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='turns_failed_total'),0) AS turns_failed,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='provider_retries_total'),0) AS provider_retries,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='tool_calls_started_total'),0) AS tool_calls_started,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='tool_calls_completed_total'),0) AS tool_calls_completed,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='tool_calls_failed_total'),0) AS tool_calls_failed,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='first_token_samples_total'),0) AS first_token_samples,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='first_token_duration_ms_total'),0) AS first_token_total_ms,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='turn_duration_samples_total'),0) AS turn_duration_samples,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='turn_duration_ms_total'),0) AS turn_duration_total_ms,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='tool_duration_samples_total'),0) AS tool_duration_samples,
                COALESCE((SELECT value FROM runtime_metric_totals WHERE metric='tool_duration_ms_total'),0) AS tool_duration_total_ms",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(RuntimeMetricsSnapshot {
            active_sessions: counts.try_get("active_sessions")?,
            queued_inputs: counts.try_get("queued_inputs")?,
            claimed_inputs: counts.try_get("claimed_inputs")?,
            active_agents: counts.try_get("active_agents")?,
            scheduled_jobs: counts.try_get("scheduled_jobs")?,
            claimed_jobs: counts.try_get("claimed_jobs")?,
            pending_connector_events: counts.try_get("pending_connector_events")?,
            pending_core_sync: counts.try_get("pending_core_sync")?,
            turns_started: counts.try_get("turns_started")?,
            turns_completed: counts.try_get("turns_completed")?,
            turns_failed: counts.try_get("turns_failed")?,
            provider_retries: counts.try_get("provider_retries")?,
            tool_calls_started: counts.try_get("tool_calls_started")?,
            tool_calls_completed: counts.try_get("tool_calls_completed")?,
            tool_calls_failed: counts.try_get("tool_calls_failed")?,
            first_token_samples: counts.try_get("first_token_samples")?,
            first_token_total_ms: counts.try_get("first_token_total_ms")?,
            turn_duration_samples: counts.try_get("turn_duration_samples")?,
            turn_duration_total_ms: counts.try_get("turn_duration_total_ms")?,
            tool_duration_samples: counts.try_get("tool_duration_samples")?,
            tool_duration_total_ms: counts.try_get("tool_duration_total_ms")?,
        })
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<EventRecord> {
        self.events.subscribe()
    }

    pub async fn initialize_workspace_state(
        &self,
        configured_path: &str,
    ) -> Result<WorkspaceStateRecord, StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT OR IGNORE INTO workspace_state(singleton, current_path, updated_at)
             VALUES (1, ?, ?)",
        )
        .bind(configured_path)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.workspace_state().await
    }

    pub async fn workspace_state(&self) -> Result<WorkspaceStateRecord, StoreError> {
        let row = sqlx::query(
            "SELECT current_path, pending_path, pending_session_id, requested_at, updated_at
             FROM workspace_state WHERE singleton = 1",
        )
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| StoreError::InvalidValue("workspace state is not initialized".to_owned()))?;
        workspace_state_from_row(&row)
    }

    pub async fn set_workspace_current(
        &self,
        path: &str,
    ) -> Result<WorkspaceStateRecord, StoreError> {
        sqlx::query(
            "UPDATE workspace_state
             SET current_path = ?, pending_path = NULL, pending_session_id = NULL,
                 requested_at = NULL, updated_at = ?
             WHERE singleton = 1",
        )
        .bind(path)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        self.workspace_state().await
    }

    pub async fn request_workspace_switch(
        &self,
        session_id: SessionId,
        path: &str,
    ) -> Result<WorkspaceStateRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let row = sqlx::query(
            "SELECT current_path, pending_path, pending_session_id, requested_at, updated_at
             FROM workspace_state WHERE singleton = 1",
        )
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| StoreError::InvalidValue("workspace state is not initialized".to_owned()))?;
        let current = workspace_state_from_row(&row)?;
        if let Some(pending) = current.pending_path.as_deref() {
            if pending == path && current.pending_session_id == Some(session_id) {
                return Ok(current);
            }
            return Err(StoreError::InvalidValue(format!(
                "another workspace switch is already pending: {pending}"
            )));
        }
        let now = now_ms();
        sqlx::query(
            "UPDATE workspace_state
             SET pending_path = ?, pending_session_id = ?, requested_at = ?, updated_at = ?
             WHERE singleton = 1",
        )
        .bind(path)
        .bind(session_id.to_string())
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "workspace.switch_requested",
            json!({"path":path,"status":"pending"}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.workspace_state().await
    }

    pub async fn workspace_runtime_is_idle(&self) -> Result<bool, StoreError> {
        let active_inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs WHERE state IN ('queued', 'claimed')",
        )
        .fetch_one(&self.pool)
        .await?;
        let active_agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_threads WHERE status IN ('queued', 'running')",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(active_inputs == 0 && active_agents == 0)
    }

    pub async fn complete_workspace_switch(
        &self,
        expected_path: &str,
    ) -> Result<WorkspaceStateRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT current_path, pending_path, pending_session_id, requested_at, updated_at
             FROM workspace_state WHERE singleton = 1",
        )
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| StoreError::InvalidValue("workspace state is not initialized".to_owned()))?;
        let pending = workspace_state_from_row(&row)?;
        if pending.pending_path.as_deref() != Some(expected_path) {
            return Err(StoreError::InvalidValue(
                "workspace switch changed before it could be applied".to_owned(),
            ));
        }
        let session_id = pending.pending_session_id.ok_or_else(|| {
            StoreError::InvalidValue("pending workspace switch has no session".to_owned())
        })?;
        let now = now_ms();
        sqlx::query(
            "UPDATE workspace_state
             SET current_path = ?, pending_path = NULL, pending_session_id = NULL,
                 requested_at = NULL, updated_at = ?
             WHERE singleton = 1 AND pending_path = ?",
        )
        .bind(expected_path)
        .bind(now)
        .bind(expected_path)
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "workspace.changed",
            json!({
                "path":expected_path,
                "name":std::path::Path::new(expected_path).file_name().and_then(|value|value.to_str()).unwrap_or("workspace")
            }),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.workspace_state().await
    }

    pub async fn fail_workspace_switch(
        &self,
        expected_path: &str,
        error: &str,
    ) -> Result<WorkspaceStateRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT pending_session_id FROM workspace_state
             WHERE singleton = 1 AND pending_path = ?",
        )
        .bind(expected_path)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            StoreError::InvalidValue("workspace switch is no longer pending".to_owned())
        })?;
        let session_id = row
            .try_get::<Option<String>, _>("pending_session_id")?
            .ok_or_else(|| {
                StoreError::InvalidValue("pending workspace switch has no session".to_owned())
            })?
            .parse::<SessionId>()?;
        sqlx::query(
            "UPDATE workspace_state
             SET pending_path = NULL, pending_session_id = NULL, requested_at = NULL, updated_at = ?
             WHERE singleton = 1 AND pending_path = ?",
        )
        .bind(now_ms())
        .bind(expected_path)
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "workspace.switch_failed",
            json!({"path":expected_path,"error":error}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.workspace_state().await
    }

    pub async fn create_session(
        &self,
        title: impl Into<String>,
    ) -> Result<SessionRecord, StoreError> {
        self.create_session_with_participants(title, Vec::new())
            .await
    }

    pub async fn create_session_with_participants(
        &self,
        title: impl Into<String>,
        participants: Vec<Value>,
    ) -> Result<SessionRecord, StoreError> {
        self.create_session_with_environment(title, participants, json!({}))
            .await
    }

    pub async fn create_session_with_environment(
        &self,
        title: impl Into<String>,
        participants: Vec<Value>,
        environment: Value,
    ) -> Result<SessionRecord, StoreError> {
        self.create_session_with_runtime_origin(
            title,
            participants,
            environment,
            SessionRuntimeOrigin::Mon,
        )
        .await
    }

    pub async fn create_session_with_runtime_origin(
        &self,
        title: impl Into<String>,
        participants: Vec<Value>,
        environment: Value,
        runtime_origin: SessionRuntimeOrigin,
    ) -> Result<SessionRecord, StoreError> {
        if !environment.is_object() {
            return Err(StoreError::InvalidValue(
                "session environment must be an object".to_owned(),
            ));
        }
        if serde_json::to_string(&environment)?.len() > 16 * 1024 {
            return Err(StoreError::InvalidValue(
                "session environment exceeds 16 KiB".to_owned(),
            ));
        }
        let now = now_ms();
        let requested_title = title.into();
        let requested_title = requested_title.trim();
        let (title, title_source) = if requested_title.is_empty() {
            ("新会话".to_owned(), "pending".to_owned())
        } else {
            (normalize_session_title(requested_title)?, "user".to_owned())
        };
        let record = SessionRecord {
            id: SessionId::new(),
            title,
            title_source,
            status: SessionStatus::Active,
            runtime_origin,
            participants,
            environment,
            context_usage: None,
            created_at: now,
            updated_at: now,
        };
        sqlx::query(
            "INSERT INTO sessions(
                id, title, title_source, status, runtime_origin, participants_json,
                environment_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(record.id.to_string())
        .bind(&record.title)
        .bind(&record.title_source)
        .bind(record.status.as_str())
        .bind(record.runtime_origin.as_str())
        .bind(serde_json::to_string(&record.participants)?)
        .bind(serde_json::to_string(&record.environment)?)
        .bind(record.created_at)
        .bind(record.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(record)
    }

    pub async fn get_session(&self, session_id: SessionId) -> Result<SessionRecord, StoreError> {
        let row = sqlx::query(
            "SELECT id, title, title_source, status, runtime_origin, participants_json, environment_json, context_usage_json,
                    created_at, updated_at FROM sessions WHERE id = ?",
        )
        .bind(session_id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::SessionNotFound(session_id))?;
        session_from_row(&row)
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, title, title_source, status, runtime_origin, participants_json, environment_json, context_usage_json,
                    created_at, updated_at FROM sessions
             WHERE status = 'active' ORDER BY updated_at DESC, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(session_from_row).collect()
    }

    pub async fn list_sessions_including_closed(&self) -> Result<Vec<SessionRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, title, title_source, status, runtime_origin, participants_json, environment_json, context_usage_json,
                    created_at, updated_at FROM sessions ORDER BY updated_at DESC, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(session_from_row).collect()
    }

    pub async fn list_sessions_for_runtime_origin(
        &self,
        runtime_origin: SessionRuntimeOrigin,
        include_closed: bool,
    ) -> Result<Vec<SessionRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, title, title_source, status, runtime_origin, participants_json, environment_json, context_usage_json,
                    created_at, updated_at FROM sessions
             WHERE runtime_origin = ? AND (? OR status = 'active')
             ORDER BY updated_at DESC, id",
        )
        .bind(runtime_origin.as_str())
        .bind(include_closed)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(session_from_row).collect()
    }

    pub async fn set_session_title(
        &self,
        session_id: SessionId,
        title: &str,
        source: &str,
    ) -> Result<SessionRecord, StoreError> {
        if !matches!(source, "generated" | "fallback" | "user" | "legacy") {
            return Err(StoreError::InvalidValue(
                "invalid session title source".to_owned(),
            ));
        }
        let title = normalize_session_title(title)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current_source: Option<String> =
            sqlx::query_scalar("SELECT title_source FROM sessions WHERE id = ?")
                .bind(session_id.to_string())
                .fetch_optional(&mut *transaction)
                .await?;
        let current_source = current_source.ok_or(StoreError::SessionNotFound(session_id))?;
        if current_source == "user" && source != "user" {
            transaction.rollback().await?;
            return self.get_session(session_id).await;
        }
        let now = now_ms();
        sqlx::query("UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE id = ?")
            .bind(&title)
            .bind(source)
            .bind(now)
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "session.title_updated",
            json!({"title":title,"titleSource":source}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.get_session(session_id).await
    }

    pub async fn claim_session_title_generation(
        &self,
        session_id: SessionId,
    ) -> Result<bool, StoreError> {
        let result = sqlx::query(
            "UPDATE sessions SET title_source = 'generating', updated_at = ?
             WHERE id = ? AND title_source IN ('pending', 'legacy', 'fallback')",
        )
        .bind(now_ms())
        .bind(session_id.to_string())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.get_session(session_id).await?;
            return Ok(false);
        }
        Ok(true)
    }

    pub async fn recover_session_title_generations(&self) -> Result<u64, StoreError> {
        Ok(sqlx::query(
            "UPDATE sessions SET title_source = 'pending', updated_at = ? WHERE title_source = 'generating'",
        )
        .bind(now_ms())
        .execute(&self.pool)
        .await?
        .rows_affected())
    }

    pub async fn delete_session(&self, session_id: SessionId) -> Result<bool, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let next_seq: Option<i64> =
            sqlx::query_scalar("SELECT next_seq FROM sessions WHERE id = ?")
                .bind(session_id.to_string())
                .fetch_optional(&mut *transaction)
                .await?;
        let next_seq = next_seq.ok_or(StoreError::SessionNotFound(session_id))?;
        let active_inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs WHERE session_id = ? AND state IN ('queued', 'claimed')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        let active_agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_threads WHERE session_id = ? AND status IN ('queued', 'running')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        if active_inputs != 0 || active_agents != 0 {
            return Err(StoreError::InvalidValue(
                "session has queued or running work".to_owned(),
            ));
        }
        let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        let deleted = result.rows_affected() != 0;
        if deleted {
            // The durable event row is removed with the session. Broadcast one
            // terminal tombstone after commit so other connected clients can
            // converge without retaining deleted sessions in memory.
            let _ = self.events.send(EventRecord {
                id: Uuid::now_v7(),
                session_id,
                seq: next_seq,
                turn_id: None,
                event_type: "session.deleted".to_owned(),
                payload: json!({"sessionID":session_id}),
                created_at: now_ms(),
            });
        }
        Ok(deleted)
    }

    /// Atomically block new work and reject deletion while any turn or
    /// sub-agent is queued/running. Returns true when an active session was
    /// transitioned to closed and therefore must be restored on remote failure.
    pub async fn begin_session_deletion(&self, session_id: SessionId) -> Result<bool, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        // Acquire SQLite's writer lock before the idle checks. A concurrent
        // enqueue can then only proceed before this transaction (and be seen)
        // or after the session has been closed (and be rejected).
        sqlx::query("UPDATE sessions SET updated_at = updated_at WHERE id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        let status: Option<String> = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
            .bind(session_id.to_string())
            .fetch_optional(&mut *transaction)
            .await?;
        let status = status.ok_or(StoreError::SessionNotFound(session_id))?;
        let active_inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs WHERE session_id = ? AND state IN ('queued', 'claimed')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        let active_agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_threads WHERE session_id = ? AND status IN ('queued', 'running')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        if active_inputs != 0 || active_agents != 0 {
            return Err(StoreError::InvalidValue(
                "session has queued or running work".to_owned(),
            ));
        }
        let changed = status == "active";
        if changed {
            sqlx::query("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?")
                .bind(now_ms())
                .bind(session_id.to_string())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(changed)
    }

    pub async fn restore_session_after_failed_delete(
        &self,
        session_id: SessionId,
    ) -> Result<(), StoreError> {
        let result =
            sqlx::query("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?")
                .bind(now_ms())
                .bind(session_id.to_string())
                .execute(&self.pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SessionNotFound(session_id));
        }
        Ok(())
    }

    pub async fn close_session(&self, session_id: SessionId) -> Result<(), StoreError> {
        let result =
            sqlx::query("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?")
                .bind(now_ms())
                .bind(session_id.to_string())
                .execute(&self.pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SessionNotFound(session_id));
        }
        Ok(())
    }

    pub async fn set_session_environment(
        &self,
        session_id: SessionId,
        environment: Value,
    ) -> Result<SessionRecord, StoreError> {
        if !environment.is_object() {
            return Err(StoreError::InvalidValue(
                "session environment must be an object".to_owned(),
            ));
        }
        let encoded = serde_json::to_string(&environment)?;
        if encoded.len() > 16 * 1024 {
            return Err(StoreError::InvalidValue(
                "session environment exceeds 16 KiB".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let current: String =
            sqlx::query_scalar("SELECT environment_json FROM sessions WHERE id = ?")
                .bind(session_id.to_string())
                .fetch_one(&mut *transaction)
                .await?;
        if current == encoded {
            transaction.commit().await?;
            return self.get_session(session_id).await;
        }
        sqlx::query("UPDATE sessions SET environment_json = ?, updated_at = ? WHERE id = ?")
            .bind(encoded)
            .bind(now_ms())
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "session.environment_updated",
            json!({"environment":environment}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.get_session(session_id).await
    }

    pub async fn set_session_participants(
        &self,
        session_id: SessionId,
        participants: Vec<Value>,
    ) -> Result<SessionRecord, StoreError> {
        self.replace_session_participants(session_id, participants)
            .await
    }

    /// Confirm that the current root run has left the session before any
    /// process-local target model binding is prepared. Queued future user
    /// inputs are intentionally allowed: the durable handoff job gates them.
    pub async fn ensure_assistant_handoff_ready(
        &self,
        session_id: SessionId,
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("UPDATE sessions SET updated_at = updated_at WHERE id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        ensure_session(&mut transaction, session_id).await?;
        ensure_no_claimed_or_running_work(&mut transaction, session_id).await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Atomically publish a prepared assistant identity and its durable model
    /// bindings, finish the handoff job, and choose exactly one next root run.
    /// No target identity becomes visible in SQLite before this transaction.
    #[allow(clippy::too_many_arguments)]
    pub async fn commit_assistant_handoff(
        &self,
        job_id: Uuid,
        session_id: SessionId,
        participant: Value,
        assistant_id: &str,
        ai_entity_id: &str,
        vision_ai_entity_id: Option<&str>,
        session_runtime_info: Value,
        actor_runtime_info: Value,
        internal_prompt: &str,
    ) -> Result<AssistantHandoffCommit, StoreError> {
        if !participant.is_object() {
            return Err(StoreError::InvalidValue(
                "assistant handoff participant must be an object".to_owned(),
            ));
        }
        let session_runtime_info = host::sanitize_model_runtime_info(&session_runtime_info);
        let actor_runtime_info = host::sanitize_model_runtime_info(&actor_runtime_info);
        let now = now_ms();
        let session_key = session_id.to_string();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("UPDATE sessions SET updated_at = updated_at WHERE id = ?")
            .bind(&session_key)
            .execute(&mut *transaction)
            .await?;
        ensure_session(&mut transaction, session_id).await?;
        ensure_no_claimed_or_running_work(&mut transaction, session_id).await?;
        let job =
            sqlx::query("SELECT kind, session_id, state, payload_json FROM jobs WHERE id = ?")
                .bind(job_id.to_string())
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or_else(|| {
                    StoreError::InvalidValue("assistant handoff job does not exist".to_owned())
                })?;
        let job_kind = job.try_get::<String, _>("kind")?;
        let job_session_id = job.try_get::<Option<String>, _>("session_id")?;
        let job_state = job.try_get::<String, _>("state")?;
        let job_payload =
            serde_json::from_str::<Value>(&job.try_get::<String, _>("payload_json")?)?;
        if job_kind != "assistant.handoff"
            || job_session_id.as_deref() != Some(session_key.as_str())
            || job_state != "claimed"
        {
            return Err(StoreError::InvalidValue(
                "assistant handoff job is not claimed for this session".to_owned(),
            ));
        }
        if job_payload.get("participant") != Some(&participant)
            || durable_id_text(job_payload.get("assistantId")).as_deref() != Some(assistant_id)
        {
            return Err(StoreError::InvalidValue(
                "assistant handoff target does not match its durable request".to_owned(),
            ));
        }
        let queued_input_resumed: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM session_inputs
                WHERE session_id = ? AND state = 'queued'
             )",
        )
        .bind(&session_key)
        .fetch_one(&mut *transaction)
        .await?;
        let queued_input_resumed = queued_input_resumed != 0;

        sqlx::query("DELETE FROM session_model_bindings WHERE session_id = ?")
            .bind(&session_key)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM session_actor_model_bindings WHERE session_id = ?")
            .bind(&session_key)
            .execute(&mut *transaction)
            .await?;
        let participants = vec![participant.clone()];
        sqlx::query("UPDATE sessions SET participants_json = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&participants)?)
            .bind(now)
            .bind(&session_key)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO session_model_bindings(
                session_id, assistant_id, ai_entity_id, vision_ai_entity_id,
                runtime_info_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&session_key)
        .bind(assistant_id)
        .bind(ai_entity_id)
        .bind(vision_ai_entity_id)
        .bind(serde_json::to_string(&session_runtime_info)?)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO session_actor_model_bindings(
                session_id, assistant_id, ai_entity_id, vision_ai_entity_id,
                runtime_info_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&session_key)
        .bind(assistant_id)
        .bind(ai_entity_id)
        .bind(vision_ai_entity_id)
        .bind(serde_json::to_string(&actor_runtime_info)?)
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        let mut events = vec![
            append_event_tx(
                &mut transaction,
                session_id,
                None,
                "session.participants_updated",
                json!({
                    "participants":participants,
                    "modelBindingsReset":true,
                    "assistantHandoff":true,
                }),
            )
            .await?,
            append_event_tx(
                &mut transaction,
                session_id,
                None,
                "session.assistant_handoff.completed",
                json!({
                    "jobId":job_id,
                    "assistantId":job_payload.get("assistantId"),
                    "participant":participant,
                    "sourceParticipant":job_payload.get("sourceParticipant"),
                    "historyPreserved":true,
                    "targetRunQueued":!queued_input_resumed,
                    "queuedInputResumed":queued_input_resumed,
                }),
            )
            .await?,
        ];
        if !queued_input_resumed {
            let input = InputRecord {
                id: OperationId::new(),
                session_id,
                turn_id: TurnId::new(),
                payload: json!({
                    "text":internal_prompt,
                    "attachments":[],
                    "jobId":job_id,
                    "jobKind":"assistant.handoff",
                    "memoId":Value::Null,
                    "internalHandoff":true,
                }),
                state: InputState::Queued,
                created_at: now,
                claimed_at: None,
                completed_at: None,
            };
            sqlx::query(
                "INSERT INTO session_inputs(
                    id, session_id, turn_id, payload_json, state, created_at
                 ) VALUES (?, ?, ?, ?, 'queued', ?)",
            )
            .bind(input.id.to_string())
            .bind(&session_key)
            .bind(input.turn_id.to_string())
            .bind(serde_json::to_string(&input.payload)?)
            .bind(input.created_at)
            .execute(&mut *transaction)
            .await?;
            events.push(
                append_event_tx(
                    &mut transaction,
                    session_id,
                    Some(input.turn_id),
                    "input.admitted",
                    json!({"inputId":input.id,"input":input.payload,"jobId":job_id}),
                )
                .await?,
            );
        }
        let completed = sqlx::query(
            "UPDATE jobs
             SET state = 'completed', lease_until = NULL, last_error = NULL, updated_at = ?
             WHERE id = ? AND state = 'claimed'",
        )
        .bind(now)
        .bind(job_id.to_string())
        .execute(&mut *transaction)
        .await?;
        if completed.rows_affected() != 1 {
            return Err(StoreError::InvalidValue(
                "assistant handoff job lost its claim before commit".to_owned(),
            ));
        }
        transaction.commit().await?;
        for event in events {
            let _ = self.events.send(event);
        }
        Ok(AssistantHandoffCommit {
            queued_input_resumed,
            target_run_enqueued: !queued_input_resumed,
        })
    }

    async fn replace_session_participants(
        &self,
        session_id: SessionId,
        participants: Vec<Value>,
    ) -> Result<SessionRecord, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("UPDATE sessions SET updated_at = updated_at WHERE id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        ensure_session(&mut transaction, session_id).await?;
        let active_inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs
             WHERE session_id = ? AND state IN ('queued', 'claimed')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        let active_agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_threads WHERE session_id = ? AND status IN ('queued', 'running')",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        if active_inputs != 0 || active_agents != 0 {
            return Err(StoreError::InvalidValue(
                "session has queued or running work".to_owned(),
            ));
        }
        sqlx::query("DELETE FROM session_model_bindings WHERE session_id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM session_actor_model_bindings WHERE session_id = ?")
            .bind(session_id.to_string())
            .execute(&mut *transaction)
            .await?;
        let result =
            sqlx::query("UPDATE sessions SET participants_json = ?, updated_at = ? WHERE id = ?")
                .bind(serde_json::to_string(&participants)?)
                .bind(now)
                .bind(session_id.to_string())
                .execute(&mut *transaction)
                .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::SessionNotFound(session_id));
        }
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "session.participants_updated",
            json!({
                "participants": participants,
                "modelBindingsReset": true,
                "assistantHandoff": false,
            }),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        self.get_session(session_id).await
    }

    pub async fn enqueue_input(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        payload: Value,
    ) -> Result<EnqueuedInput, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let input = InputRecord {
            id: OperationId::new(),
            session_id,
            turn_id,
            payload,
            state: InputState::Queued,
            created_at: now_ms(),
            claimed_at: None,
            completed_at: None,
        };
        sqlx::query(
            "INSERT INTO session_inputs(id, session_id, turn_id, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
        )
        .bind(input.id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(serde_json::to_string(&input.payload)?)
        .bind(input.created_at)
        .execute(&mut *transaction)
        .await?;
        let admitted_event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "input.admitted",
            serde_json::json!({"inputId": input.id, "input": input.payload.clone()}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(admitted_event.clone());
        Ok(EnqueuedInput {
            input,
            admitted_event,
        })
    }

    /// Enqueue one durable input per durable job. Repeated dispatch after a
    /// lease expiry only wakes the existing input; an interrupted input is
    /// explicitly requeued and a completed input closes the stale job lease.
    pub async fn enqueue_job_input(
        &self,
        session_id: SessionId,
        turn_id: TurnId,
        job_id: Uuid,
        payload: Value,
    ) -> Result<Option<EnqueuedInput>, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let existing = sqlx::query(
            "SELECT id, session_id, turn_id, payload_json, state, created_at, claimed_at, completed_at
             FROM session_inputs WHERE json_extract(payload_json, '$.jobId') = ? LIMIT 1",
        )
        .bind(job_id.to_string())
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(row) = existing {
            let mut input = input_from_row(&row)?;
            match input.state {
                InputState::Interrupted => {
                    sqlx::query("UPDATE session_inputs SET state='queued', claimed_at=NULL, completed_at=NULL WHERE id=?")
                        .bind(input.id.to_string())
                        .execute(&mut *transaction)
                        .await?;
                    let event = append_event_tx(
                        &mut transaction,
                        session_id,
                        Some(input.turn_id),
                        "input.requeued",
                        json!({"inputId":input.id,"jobId":job_id}),
                    )
                    .await?;
                    transaction.commit().await?;
                    input.state = InputState::Queued;
                    input.claimed_at = None;
                    input.completed_at = None;
                    let _ = self.events.send(event.clone());
                    return Ok(Some(EnqueuedInput {
                        input,
                        admitted_event: event,
                    }));
                }
                InputState::Completed => {
                    sqlx::query("UPDATE jobs SET state='completed', lease_until=NULL, updated_at=? WHERE id=?")
                        .bind(now_ms())
                        .bind(job_id.to_string())
                        .execute(&mut *transaction)
                        .await?;
                }
                InputState::Queued | InputState::Claimed => {}
            }
            transaction.commit().await?;
            return Ok(None);
        }
        let input = InputRecord {
            id: OperationId::new(),
            session_id,
            turn_id,
            payload,
            state: InputState::Queued,
            created_at: now_ms(),
            claimed_at: None,
            completed_at: None,
        };
        sqlx::query(
            "INSERT INTO session_inputs(id, session_id, turn_id, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
        )
        .bind(input.id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(serde_json::to_string(&input.payload)?)
        .bind(input.created_at)
        .execute(&mut *transaction)
        .await?;
        let admitted_event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "input.admitted",
            json!({"inputId":input.id,"input":input.payload.clone(),"jobId":job_id}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(admitted_event.clone());
        Ok(Some(EnqueuedInput {
            input,
            admitted_event,
        }))
    }

    pub async fn claim_next_input(
        &self,
        session_id: SessionId,
    ) -> Result<Option<InputRecord>, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let handoff_pending: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE session_id = ? AND kind = 'assistant.handoff' AND state IN ('scheduled', 'claimed'))",
        )
        .bind(session_id.to_string())
        .fetch_one(&mut *transaction)
        .await?;
        if handoff_pending != 0 {
            transaction.commit().await?;
            return Ok(None);
        }
        let row = sqlx::query(
            "SELECT id, session_id, turn_id, payload_json, state, created_at, claimed_at, completed_at
             FROM session_inputs WHERE session_id = ? AND state = 'queued'
             ORDER BY created_at, id LIMIT 1",
        )
        .bind(session_id.to_string())
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let mut input = input_from_row(&row)?;
        let claimed_at = now_ms();
        sqlx::query("UPDATE session_inputs SET state = 'claimed', claimed_at = ? WHERE id = ? AND state = 'queued'")
            .bind(claimed_at)
            .bind(input.id.to_string())
            .execute(&mut *transaction)
            .await?;
        let claimed_event = append_event_tx(
            &mut transaction,
            session_id,
            Some(input.turn_id),
            "input.claimed",
            serde_json::json!({"inputId": input.id}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(claimed_event);
        input.state = InputState::Claimed;
        input.claimed_at = Some(claimed_at);
        Ok(Some(input))
    }

    pub async fn has_pending_input(&self, session_id: SessionId) -> Result<bool, StoreError> {
        let pending: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM session_inputs WHERE session_id = ? AND state IN ('queued', 'claimed'))",
        )
        .bind(session_id.to_string())
        .fetch_one(&self.pool)
        .await?;
        Ok(pending != 0)
    }

    pub async fn session_has_active_work(&self, session_id: SessionId) -> Result<bool, StoreError> {
        self.get_session(session_id).await?;
        let active_inputs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs WHERE session_id = ? AND state IN ('queued', 'claimed')",
        )
        .bind(session_id.to_string())
        .fetch_one(&self.pool)
        .await?;
        let active_agents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_threads WHERE session_id = ? AND status IN ('queued', 'running')",
        )
        .bind(session_id.to_string())
        .fetch_one(&self.pool)
        .await?;
        Ok(active_inputs != 0 || active_agents != 0)
    }

    pub async fn complete_input(&self, input: &InputRecord) -> Result<EventRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let completed_at = now_ms();
        sqlx::query("UPDATE session_inputs SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'claimed'")
            .bind(completed_at)
            .bind(input.id.to_string())
            .execute(&mut *transaction)
            .await?;
        let event = append_event_tx(
            &mut transaction,
            input.session_id,
            Some(input.turn_id),
            "input.completed",
            serde_json::json!({"inputId": input.id}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(event)
    }

    pub async fn interrupt_input(
        &self,
        input: &InputRecord,
        reason: impl Into<String>,
    ) -> Result<EventRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let completed_at = now_ms();
        sqlx::query(
            "UPDATE session_inputs SET state = 'interrupted', completed_at = ? WHERE id = ? AND state = 'claimed'",
        )
        .bind(completed_at)
        .bind(input.id.to_string())
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            input.session_id,
            Some(input.turn_id),
            "input.interrupted",
            serde_json::json!({"inputId": input.id, "reason": reason.into()}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(event)
    }

    pub async fn recover_claimed_inputs(&self) -> Result<u64, StoreError> {
        let result = sqlx::query(
            "UPDATE session_inputs SET state = 'queued', claimed_at = NULL WHERE state = 'claimed'",
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn append_event(
        &self,
        session_id: SessionId,
        turn_id: Option<TurnId>,
        event_type: impl Into<String>,
        payload: Value,
    ) -> Result<EventRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            turn_id,
            &event_type.into(),
            payload,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(event)
    }

    pub async fn list_events(
        &self,
        session_id: SessionId,
        after_seq: i64,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq",
        )
        .bind(session_id.to_string())
        .bind(after_seq)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(event_from_row).collect()
    }

    pub async fn list_director_events(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<EventRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events
             WHERE session_id = ? AND event_type IN (
                 'companion.director.started',
                 'companion.plan',
                 'companion.speaker.started',
                 'companion.speaker.finished',
                 'companion.director.completed',
                 'companion.director.failed'
             )
             ORDER BY seq",
        )
        .bind(session_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(event_from_row).collect()
    }

    pub async fn list_event_page(
        &self,
        session_id: SessionId,
        after_seq: i64,
        limit: u32,
    ) -> Result<EventPageRecord, StoreError> {
        let limit = limit.clamp(1, 500) as usize;
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        )
        .bind(session_id.to_string())
        .bind(after_seq.max(0))
        .bind(i64::try_from(limit + 1).unwrap_or(501))
        .fetch_all(&self.pool)
        .await?;
        let has_more = rows.len() > limit;
        let mut items = rows
            .iter()
            .take(limit)
            .map(event_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = has_more.then(|| {
            items
                .last()
                .map(|event| event.seq.to_string())
                .unwrap_or_else(|| after_seq.max(0).to_string())
        });
        Ok(EventPageRecord {
            items: std::mem::take(&mut items),
            next_cursor,
            has_more,
        })
    }

    pub async fn list_message_event_page(
        &self,
        session_id: SessionId,
        before: Option<&str>,
        limit: u32,
    ) -> Result<EventPageRecord, StoreError> {
        let before_seq = if let Some(before) = before.filter(|value| !value.trim().is_empty()) {
            sqlx::query_scalar::<_, i64>(
                "SELECT seq FROM session_events
                 WHERE session_id = ? AND id = ? AND event_type = 'agent.message_end'",
            )
            .bind(session_id.to_string())
            .bind(before)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::InvalidValue("message cursor not found".to_owned()))?
        } else {
            i64::MAX
        };
        let limit = limit.clamp(1, 100) as usize;
        let rows = sqlx::query(
            "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
             FROM session_events
             WHERE session_id = ? AND event_type = 'agent.message_end' AND seq < ?
             ORDER BY seq DESC LIMIT ?",
        )
        .bind(session_id.to_string())
        .bind(before_seq)
        .bind(i64::try_from(limit + 1).unwrap_or(101))
        .fetch_all(&self.pool)
        .await?;
        let has_more = rows.len() > limit;
        let mut items = rows
            .iter()
            .take(limit)
            .map(event_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        items.reverse();
        let next_cursor = has_more.then(|| {
            items
                .first()
                .map(|event| event.id.to_string())
                .unwrap_or_default()
        });
        if let (Some(first), Some(last)) = (items.first(), items.last()) {
            let previous_message_seq = sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(seq), 0) FROM session_events
                 WHERE session_id = ? AND event_type = 'agent.message_end' AND seq < ?",
            )
            .bind(session_id.to_string())
            .bind(first.seq)
            .fetch_one(&self.pool)
            .await?;
            let companion_rows = sqlx::query(
                "SELECT id, session_id, seq, turn_id, event_type, payload_json, created_at
                 FROM session_events
                 WHERE session_id = ? AND event_type = 'character.sticker.sent'
                   AND seq > ? AND seq <= ?
                 ORDER BY seq",
            )
            .bind(session_id.to_string())
            .bind(previous_message_seq)
            .bind(last.seq)
            .fetch_all(&self.pool)
            .await?;
            items.extend(
                companion_rows
                    .iter()
                    .map(event_from_row)
                    .collect::<Result<Vec<_>, _>>()?,
            );
            items.sort_by_key(|event| event.seq);
        }
        Ok(EventPageRecord {
            items,
            next_cursor,
            has_more,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_permission(
        &self,
        id: PermissionRequestId,
        session_id: SessionId,
        turn_id: TurnId,
        operation_id: OperationId,
        capability: impl Into<String>,
        resource: impl Into<String>,
        request: Value,
    ) -> Result<PermissionMutation, StoreError> {
        let capability = capability.into();
        let resource = resource.into();
        let created_at = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        sqlx::query(
            "INSERT INTO permission_requests(
                id, session_id, turn_id, operation_id, capability, resource, state, request_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .bind(id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(operation_id.to_string())
        .bind(&capability)
        .bind(&resource)
        .bind(serde_json::to_string(&request)?)
        .bind(created_at)
        .execute(&mut *transaction)
        .await?;
        let permission = PermissionRecord {
            id,
            session_id,
            turn_id,
            operation_id,
            capability,
            resource,
            state: PermissionState::Pending,
            request,
            decision: None,
            created_at,
            resolved_at: None,
        };
        let event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "permission.requested",
            serde_json::to_value(&permission)?,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(PermissionMutation { permission, event })
    }

    pub async fn resolve_permission(
        &self,
        id: PermissionRequestId,
        decision_name: &str,
        decision: Value,
    ) -> Result<PermissionMutation, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT id, session_id, turn_id, operation_id, capability, resource, state,
                    request_json, decision_json, created_at, resolved_at
             FROM permission_requests WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::PermissionNotFound(id))?;
        let mut permission = permission_from_row(&row)?;
        if permission.state != PermissionState::Pending {
            return Err(StoreError::PermissionAlreadyResolved(id));
        }
        let state = if decision_name == "deny" {
            "denied"
        } else {
            "allowed"
        };
        let resolved_at = now_ms();
        sqlx::query(
            "UPDATE permission_requests SET state = ?, decision_json = ?, resolved_at = ?
             WHERE id = ? AND state = 'pending'",
        )
        .bind(state)
        .bind(serde_json::to_string(&decision)?)
        .bind(resolved_at)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        permission.state = if state == "allowed" {
            PermissionState::Allowed
        } else {
            PermissionState::Denied
        };
        permission.decision = Some(decision.clone());
        permission.resolved_at = Some(resolved_at);
        let event = append_event_tx(
            &mut transaction,
            permission.session_id,
            Some(permission.turn_id),
            "permission.resolved",
            serde_json::json!({
                "requestId": id,
                "decision": decision,
                "state": state,
            }),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(PermissionMutation { permission, event })
    }

    pub async fn list_pending_permissions(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<Vec<PermissionRecord>, StoreError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT id, session_id, turn_id, operation_id, capability, resource, state,
                        request_json, decision_json, created_at, resolved_at
                 FROM permission_requests WHERE state = 'pending' AND session_id = ? ORDER BY created_at, id",
            )
            .bind(session_id.to_string())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, session_id, turn_id, operation_id, capability, resource, state,
                        request_json, decision_json, created_at, resolved_at
                 FROM permission_requests WHERE state = 'pending' ORDER BY created_at, id",
            )
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(permission_from_row).collect()
    }

    pub async fn create_question(
        &self,
        id: QuestionRequestId,
        session_id: SessionId,
        turn_id: TurnId,
        questions: Value,
    ) -> Result<QuestionMutation, StoreError> {
        let created_at = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        sqlx::query(
            "INSERT INTO question_requests(id, session_id, turn_id, state, questions_json, created_at)
             VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .bind(id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(serde_json::to_string(&questions)?)
        .bind(created_at)
        .execute(&mut *transaction)
        .await?;
        let question = QuestionRecord {
            id,
            session_id,
            turn_id,
            state: QuestionState::Pending,
            questions,
            answers: None,
            created_at,
            resolved_at: None,
        };
        let event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "question.requested",
            serde_json::to_value(&question)?,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(QuestionMutation { question, event })
    }

    pub async fn create_question_idempotent(
        &self,
        id: QuestionRequestId,
        session_id: SessionId,
        turn_id: TurnId,
        questions: Value,
    ) -> Result<Option<QuestionMutation>, StoreError> {
        let created_at = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO question_requests(
                id, session_id, turn_id, state, questions_json, created_at
             ) VALUES (?, ?, ?, 'pending', ?, ?)",
        )
        .bind(id.to_string())
        .bind(session_id.to_string())
        .bind(turn_id.to_string())
        .bind(serde_json::to_string(&questions)?)
        .bind(created_at)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if inserted == 0 {
            transaction.commit().await?;
            return Ok(None);
        }
        let question = QuestionRecord {
            id,
            session_id,
            turn_id,
            state: QuestionState::Pending,
            questions,
            answers: None,
            created_at,
            resolved_at: None,
        };
        let event = append_event_tx(
            &mut transaction,
            session_id,
            Some(turn_id),
            "question.requested",
            serde_json::to_value(&question)?,
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(Some(QuestionMutation { question, event }))
    }

    pub async fn resolve_question(
        &self,
        id: QuestionRequestId,
        answers: Value,
    ) -> Result<QuestionMutation, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT id, session_id, turn_id, state, questions_json, answers_json, created_at, resolved_at
             FROM question_requests WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::QuestionNotFound(id))?;
        let mut question = question_from_row(&row)?;
        if question.state != QuestionState::Pending {
            return Err(StoreError::QuestionAlreadyResolved(id));
        }
        let resolved_at = now_ms();
        sqlx::query(
            "UPDATE question_requests SET state = 'answered', answers_json = ?, resolved_at = ?
             WHERE id = ? AND state = 'pending'",
        )
        .bind(serde_json::to_string(&answers)?)
        .bind(resolved_at)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        question.state = QuestionState::Answered;
        question.answers = Some(answers.clone());
        question.resolved_at = Some(resolved_at);
        let event = append_event_tx(
            &mut transaction,
            question.session_id,
            Some(question.turn_id),
            "question.resolved",
            serde_json::json!({"requestId": id, "answers": answers}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(QuestionMutation { question, event })
    }

    pub async fn reject_question(
        &self,
        id: QuestionRequestId,
    ) -> Result<QuestionMutation, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "SELECT id, session_id, turn_id, state, questions_json, answers_json, created_at, resolved_at
             FROM question_requests WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StoreError::QuestionNotFound(id))?;
        let mut question = question_from_row(&row)?;
        if question.state != QuestionState::Pending {
            return Err(StoreError::QuestionAlreadyResolved(id));
        }
        let resolved_at = now_ms();
        sqlx::query(
            "UPDATE question_requests SET state = 'rejected', answers_json = NULL, resolved_at = ?
             WHERE id = ? AND state = 'pending'",
        )
        .bind(resolved_at)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        question.state = QuestionState::Rejected;
        question.answers = None;
        question.resolved_at = Some(resolved_at);
        let event = append_event_tx(
            &mut transaction,
            question.session_id,
            Some(question.turn_id),
            "question.resolved",
            serde_json::json!({"requestId": id, "state": "rejected"}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event.clone());
        Ok(QuestionMutation { question, event })
    }

    pub async fn list_pending_questions(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<Vec<QuestionRecord>, StoreError> {
        let rows = if let Some(session_id) = session_id {
            sqlx::query(
                "SELECT id, session_id, turn_id, state, questions_json, answers_json, created_at, resolved_at
                 FROM question_requests WHERE state = 'pending' AND session_id = ? ORDER BY created_at, id",
            )
            .bind(session_id.to_string())
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, session_id, turn_id, state, questions_json, answers_json, created_at, resolved_at
                 FROM question_requests WHERE state = 'pending' ORDER BY created_at, id",
            )
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(question_from_row).collect()
    }

    pub async fn create_agent_thread(
        &self,
        session_id: SessionId,
        parent_id: Option<AgentId>,
        agent_path: impl Into<String>,
        task_name: impl Into<String>,
        role: impl Into<String>,
        prompt: impl Into<String>,
    ) -> Result<AgentThreadRecord, StoreError> {
        self.create_agent_thread_configured(
            session_id,
            parent_id,
            agent_path,
            task_name,
            role,
            prompt,
            serde_json::json!({}),
            None,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_agent_thread_configured(
        &self,
        session_id: SessionId,
        parent_id: Option<AgentId>,
        agent_path: impl Into<String>,
        task_name: impl Into<String>,
        role: impl Into<String>,
        prompt: impl Into<String>,
        config: Value,
        deadline_at: Option<i64>,
        coordination_batch_id: Option<String>,
    ) -> Result<AgentThreadRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let now = now_ms();
        let record = AgentThreadRecord {
            id: AgentId::new(),
            session_id,
            parent_id,
            agent_path: agent_path.into(),
            task_name: task_name.into(),
            role: role.into(),
            prompt: prompt.into(),
            status: "queued".to_owned(),
            context: None,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            started_at: None,
            completed_at: None,
            config,
            usage: serde_json::json!({"turns":0,"toolCalls":0,"tokens":0,"costMicrousd":0}),
            deadline_at,
            coordination_batch_id,
        };
        sqlx::query(
            "INSERT INTO agent_threads(
                id, session_id, parent_id, agent_path, task_name, role, prompt, status, created_at, updated_at,
                config_json, usage_json, deadline_at, coordination_batch_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
        )
        .bind(record.id.to_string())
        .bind(session_id.to_string())
        .bind(parent_id.map(|id| id.to_string()))
        .bind(&record.agent_path)
        .bind(&record.task_name)
        .bind(&record.role)
        .bind(&record.prompt)
        .bind(now)
        .bind(now)
        .bind(serde_json::to_string(&record.config)?)
        .bind(serde_json::to_string(&record.usage)?)
        .bind(record.deadline_at)
        .bind(&record.coordination_batch_id)
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "subagent.created",
            serde_json::json!({"agent": record}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn get_agent_thread(&self, id: AgentId) -> Result<AgentThreadRecord, StoreError> {
        let row = sqlx::query(
            "SELECT id, session_id, parent_id, agent_path, task_name, role, prompt, status,
                    context_json, result_json, error, created_at, updated_at, started_at, completed_at,
                    config_json, usage_json, deadline_at, coordination_batch_id
             FROM agent_threads WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::AgentNotFound(id))?;
        agent_thread_from_row(&row)
    }

    pub async fn reserve_agent_usage(
        &self,
        id: AgentId,
        field: &str,
        amount: u64,
        maximum: u64,
    ) -> Result<Value, StoreError> {
        if !matches!(field, "turns" | "toolCalls" | "tokens" | "costMicrousd") {
            return Err(StoreError::InvalidValue(format!(
                "invalid agent usage field: {field}"
            )));
        }
        let amount_sql = i64::try_from(amount)
            .map_err(|_| StoreError::InvalidValue("agent usage amount is too large".to_owned()))?;
        let maximum_sql = i64::try_from(maximum)
            .map_err(|_| StoreError::InvalidValue("agent usage limit is too large".to_owned()))?;
        let path = format!("$.{field}");
        let changed = sqlx::query(
            "UPDATE agent_threads
             SET usage_json = json_set(
                    usage_json, ?, COALESCE(json_extract(usage_json, ?), 0) + ?
                 ),
                 updated_at = ?
             WHERE id = ?
               AND COALESCE(json_extract(usage_json, ?), 0) + ? <= ?",
        )
        .bind(&path)
        .bind(&path)
        .bind(amount_sql)
        .bind(now_ms())
        .bind(id.to_string())
        .bind(&path)
        .bind(amount_sql)
        .bind(maximum_sql)
        .execute(&self.pool)
        .await?;
        let raw: Option<String> =
            sqlx::query_scalar("SELECT usage_json FROM agent_threads WHERE id = ?")
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await?;
        let raw = raw.ok_or(StoreError::AgentNotFound(id))?;
        let usage: Value = serde_json::from_str(&raw)?;
        if changed.rows_affected() == 0 {
            let current = usage.get(field).and_then(Value::as_u64).unwrap_or(0);
            return Err(StoreError::InvalidValue(format!(
                "sub-agent {field} budget exceeded ({current}/{maximum})"
            )));
        }
        Ok(usage)
    }

    pub async fn checkpoint_agent_thread(
        &self,
        id: AgentId,
        context: Value,
    ) -> Result<(), StoreError> {
        let changed = sqlx::query(
            "UPDATE agent_threads SET context_json = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(serde_json::to_string(&context)?)
        .bind(now_ms())
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::AgentNotMutable(id));
        }
        Ok(())
    }

    pub async fn list_agent_threads(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<AgentThreadRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, parent_id, agent_path, task_name, role, prompt, status,
                    context_json, result_json, error, created_at, updated_at, started_at, completed_at,
                    config_json, usage_json, deadline_at, coordination_batch_id
             FROM agent_threads WHERE session_id = ? ORDER BY created_at, id",
        )
        .bind(session_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(agent_thread_from_row).collect()
    }

    pub async fn recover_agent_threads(&self) -> Result<Vec<AgentThreadRecord>, StoreError> {
        sqlx::query(
            "UPDATE agent_threads SET status = 'queued', updated_at = ?, started_at = NULL
             WHERE status = 'running'",
        )
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        let rows = sqlx::query(
            "SELECT id, session_id, parent_id, agent_path, task_name, role, prompt, status,
                    context_json, result_json, error, created_at, updated_at, started_at, completed_at,
                    config_json, usage_json, deadline_at, coordination_batch_id
             FROM agent_threads WHERE status = 'queued' ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(agent_thread_from_row).collect()
    }

    pub async fn start_agent_thread(&self, id: AgentId) -> Result<AgentThreadRecord, StoreError> {
        self.mutate_agent_thread(id, "running", None, None, "subagent.started", "queued")
            .await
    }

    pub async fn complete_agent_thread(
        &self,
        id: AgentId,
        context: Value,
        result: Value,
    ) -> Result<AgentThreadRecord, StoreError> {
        self.mutate_agent_thread(
            id,
            "completed",
            Some(context),
            Some(result),
            "subagent.completed",
            "running",
        )
        .await
    }

    pub async fn fail_agent_thread(
        &self,
        id: AgentId,
        error: impl Into<String>,
    ) -> Result<AgentThreadRecord, StoreError> {
        let error = error.into();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query(
            "UPDATE agent_threads SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(&error)
        .bind(now_ms())
        .bind(now_ms())
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::AgentNotMutable(id));
        }
        let record = get_agent_thread_tx(&mut transaction, id).await?;
        let event = append_event_tx(
            &mut transaction,
            record.session_id,
            None,
            "subagent.failed",
            serde_json::json!({"agent": record, "error": error}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn interrupt_agent_thread(
        &self,
        id: AgentId,
    ) -> Result<AgentThreadRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        let changed = sqlx::query(
            "UPDATE agent_threads SET status = 'interrupted', updated_at = ?, completed_at = ?
             WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(now)
        .bind(now)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::AgentNotMutable(id));
        }
        let record = get_agent_thread_tx(&mut transaction, id).await?;
        let event = append_event_tx(
            &mut transaction,
            record.session_id,
            None,
            "subagent.interrupted",
            serde_json::json!({"agent": record}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn requeue_agent_thread(
        &self,
        id: AgentId,
        prompt: impl Into<String>,
    ) -> Result<AgentThreadRecord, StoreError> {
        let prompt = prompt.into();
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query(
            "UPDATE agent_threads SET status = 'queued', prompt = ?, result_json = NULL, error = NULL,
                    updated_at = ?, started_at = NULL, completed_at = NULL
             WHERE id = ? AND status IN ('completed', 'failed', 'interrupted')",
        )
        .bind(&prompt)
        .bind(now)
        .bind(id.to_string())
        .execute(&mut *transaction)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::AgentNotMutable(id));
        }
        let record = get_agent_thread_tx(&mut transaction, id).await?;
        let event = append_event_tx(
            &mut transaction,
            record.session_id,
            None,
            "subagent.followup_queued",
            serde_json::json!({"agent": record}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn enqueue_agent_message(
        &self,
        session_id: SessionId,
        sender_path: impl Into<String>,
        target_path: impl Into<String>,
        content: impl Into<String>,
        kind: impl Into<String>,
        trigger_turn: bool,
        details: Value,
    ) -> Result<AgentMailboxRecord, StoreError> {
        let record = AgentMailboxRecord {
            id: Uuid::now_v7(),
            session_id,
            sender_path: sender_path.into(),
            target_path: target_path.into(),
            content: content.into(),
            kind: kind.into(),
            trigger_turn,
            details,
            created_at: now_ms(),
            consumed_at: None,
        };
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        sqlx::query(
            "INSERT INTO agent_mailbox(
                id, session_id, sender_path, target_path, content, kind, trigger_turn, details_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(record.id.to_string())
        .bind(session_id.to_string())
        .bind(&record.sender_path)
        .bind(&record.target_path)
        .bind(&record.content)
        .bind(&record.kind)
        .bind(record.trigger_turn)
        .bind(serde_json::to_string(&record.details)?)
        .bind(record.created_at)
        .execute(&mut *transaction)
        .await?;
        let event = append_event_tx(
            &mut transaction,
            session_id,
            None,
            "subagent.message_queued",
            serde_json::json!({"message": record}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn pending_agent_messages(
        &self,
        session_id: SessionId,
        target_path: &str,
    ) -> Result<Vec<AgentMailboxRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT id, session_id, sender_path, target_path, content, kind, trigger_turn,
                    details_json, created_at, consumed_at
             FROM agent_mailbox
             WHERE session_id = ? AND target_path = ? AND consumed_at IS NULL
             ORDER BY created_at, id",
        )
        .bind(session_id.to_string())
        .bind(target_path)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(agent_mailbox_from_row).collect()
    }

    pub async fn consume_agent_messages(&self, ids: &[Uuid]) -> Result<(), StoreError> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        for id in ids {
            sqlx::query(
                "UPDATE agent_mailbox SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
            )
            .bind(now_ms())
            .bind(id.to_string())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    async fn mutate_agent_thread(
        &self,
        id: AgentId,
        next_status: &str,
        context: Option<Value>,
        result: Option<Value>,
        event_type: &str,
        required_status: &str,
    ) -> Result<AgentThreadRecord, StoreError> {
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query(
            "UPDATE agent_threads SET status = ?, context_json = COALESCE(?, context_json),
                    result_json = COALESCE(?, result_json), updated_at = ?,
                    started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
                    completed_at = CASE WHEN ? IN ('completed', 'interrupted') THEN ? ELSE completed_at END
             WHERE id = ? AND status = ?",
        )
        .bind(next_status)
        .bind(context.as_ref().map(serde_json::to_string).transpose()?)
        .bind(result.as_ref().map(serde_json::to_string).transpose()?)
        .bind(now)
        .bind(next_status)
        .bind(now)
        .bind(next_status)
        .bind(now)
        .bind(id.to_string())
        .bind(required_status)
        .execute(&mut *transaction)
        .await?;
        if changed.rows_affected() == 0 {
            return Err(StoreError::AgentNotMutable(id));
        }
        let record = get_agent_thread_tx(&mut transaction, id).await?;
        let event = append_event_tx(
            &mut transaction,
            record.session_id,
            None,
            event_type,
            serde_json::json!({"agent": record}),
        )
        .await?;
        transaction.commit().await?;
        let _ = self.events.send(event);
        Ok(record)
    }

    pub async fn put_blob_metadata(
        &self,
        sha256: impl Into<String>,
        mime: impl Into<String>,
        byte_length: i64,
        storage_path: impl Into<String>,
    ) -> Result<BlobRecord, StoreError> {
        let sha256 = sha256.into();
        let mime = mime.into();
        let storage_path = storage_path.into();
        let id = BlobId::new();
        let created_at = now_ms();
        sqlx::query(
            "INSERT OR IGNORE INTO blobs(id, sha256, mime, byte_length, storage_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(&sha256)
        .bind(&mime)
        .bind(byte_length)
        .bind(&storage_path)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        let row = sqlx::query(
            "SELECT id, sha256, mime, byte_length, storage_path, created_at
             FROM blobs WHERE sha256 = ?",
        )
        .bind(&sha256)
        .fetch_one(&self.pool)
        .await?;
        blob_from_row(&row)
    }

    pub async fn get_blob(&self, id: BlobId) -> Result<BlobRecord, StoreError> {
        let row = sqlx::query(
            "SELECT id, sha256, mime, byte_length, storage_path, created_at FROM blobs WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::BlobNotFound(id))?;
        blob_from_row(&row)
    }

    pub async fn upsert_voice_speech_segment(
        &self,
        input: VoiceSpeechSegmentUpsert,
    ) -> Result<VoiceSpeechSegmentRecord, StoreError> {
        if input.external_message_id.trim().is_empty()
            || input.segment_group_id.trim().is_empty()
            || input.audio_format.trim().is_empty()
            || input.text_hash.trim().is_empty()
            || input.group_index < 0
            || input.sequence < 0
            || input.text_length < 0
            || input.duration_ms.is_some_and(|value| value < 0)
        {
            return Err(StoreError::InvalidValue(
                "invalid voice speech segment".to_owned(),
            ));
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, input.session_id).await?;
        let now = now_ms();
        // Sequence zero starts a fresh rendering of this logical speech group.
        // Remove later segments from an older rendering so a changed chunk plan
        // cannot leave stale audio behind after a retry or application restart.
        if input.sequence == 0 {
            sqlx::query(
                "DELETE FROM voice_speech_segments
                 WHERE session_id = ? AND external_message_id = ?
                   AND segment_group_id = ? AND sequence > 0",
            )
            .bind(input.session_id.to_string())
            .bind(&input.external_message_id)
            .bind(&input.segment_group_id)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            "INSERT INTO voice_speech_segments(
                session_id, external_message_id, external_audio_asset_id, audio_blob_id,
                duration_ms, audio_format, segment_group_id, group_index, sequence,
                text_hash, text_length, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, external_message_id, segment_group_id, sequence)
             DO UPDATE SET
                external_audio_asset_id=excluded.external_audio_asset_id,
                audio_blob_id=excluded.audio_blob_id,
                duration_ms=excluded.duration_ms,
                audio_format=excluded.audio_format,
                group_index=excluded.group_index,
                text_hash=excluded.text_hash,
                text_length=excluded.text_length,
                updated_at=excluded.updated_at",
        )
        .bind(input.session_id.to_string())
        .bind(&input.external_message_id)
        .bind(input.external_audio_asset_id)
        .bind(input.audio_blob_id.to_string())
        .bind(input.duration_ms)
        .bind(&input.audio_format)
        .bind(&input.segment_group_id)
        .bind(input.group_index)
        .bind(input.sequence)
        .bind(&input.text_hash)
        .bind(input.text_length)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        let row = sqlx::query(
            "SELECT id, session_id, external_message_id, external_audio_asset_id,
                    audio_blob_id, duration_ms, audio_format, segment_group_id,
                    group_index, sequence, text_hash, text_length, created_at, updated_at
             FROM voice_speech_segments
             WHERE session_id = ? AND external_message_id = ?
               AND segment_group_id = ? AND sequence = ?",
        )
        .bind(input.session_id.to_string())
        .bind(&input.external_message_id)
        .bind(&input.segment_group_id)
        .bind(input.sequence)
        .fetch_one(&mut *transaction)
        .await?;
        let record = voice_speech_segment_from_row(&row)?;
        transaction.commit().await?;
        Ok(record)
    }

    pub async fn list_voice_speech_segments(
        &self,
        session_id: SessionId,
        message_id: Option<&str>,
    ) -> Result<Vec<VoiceSpeechSegmentRecord>, StoreError> {
        self.get_session(session_id).await?;
        let rows = if let Some(message_id) = message_id.filter(|value| !value.trim().is_empty()) {
            sqlx::query(
                "SELECT id, session_id, external_message_id, external_audio_asset_id,
                        audio_blob_id, duration_ms, audio_format, segment_group_id,
                        group_index, sequence, text_hash, text_length, created_at, updated_at
                 FROM voice_speech_segments
                 WHERE session_id = ? AND external_message_id = ?
                 ORDER BY group_index ASC, sequence ASC, id ASC",
            )
            .bind(session_id.to_string())
            .bind(message_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, session_id, external_message_id, external_audio_asset_id,
                        audio_blob_id, duration_ms, audio_format, segment_group_id,
                        group_index, sequence, text_hash, text_length, created_at, updated_at
                 FROM voice_speech_segments
                 WHERE session_id = ?
                 ORDER BY external_message_id ASC, group_index ASC, sequence ASC, id ASC",
            )
            .bind(session_id.to_string())
            .fetch_all(&self.pool)
            .await?
        };
        rows.iter().map(voice_speech_segment_from_row).collect()
    }
}

async fn ensure_session(
    transaction: &mut Transaction<'_, Sqlite>,
    session_id: SessionId,
) -> Result<(), StoreError> {
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
        .bind(session_id.to_string())
        .fetch_optional(&mut **transaction)
        .await?;
    match status.as_deref() {
        None => return Err(StoreError::SessionNotFound(session_id)),
        Some("closed") => return Err(StoreError::SessionClosed(session_id)),
        Some(_) => {}
    }
    Ok(())
}

async fn ensure_no_claimed_or_running_work(
    transaction: &mut Transaction<'_, Sqlite>,
    session_id: SessionId,
) -> Result<(), StoreError> {
    let active_inputs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM session_inputs
         WHERE session_id = ? AND state = 'claimed'",
    )
    .bind(session_id.to_string())
    .fetch_one(&mut **transaction)
    .await?;
    let active_agents: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_threads
         WHERE session_id = ? AND status IN ('queued', 'running')",
    )
    .bind(session_id.to_string())
    .fetch_one(&mut **transaction)
    .await?;
    if active_inputs != 0 || active_agents != 0 {
        return Err(StoreError::InvalidValue(
            "session still has a claimed root input or active agent thread".to_owned(),
        ));
    }
    Ok(())
}

fn durable_id_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

async fn append_event_tx(
    transaction: &mut Transaction<'_, Sqlite>,
    session_id: SessionId,
    turn_id: Option<TurnId>,
    event_type: &str,
    payload: Value,
) -> Result<EventRecord, StoreError> {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ? RETURNING next_seq - 1",
    )
    .bind(now_ms())
    .bind(session_id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StoreError::SessionNotFound(session_id))?;
    let event = EventRecord {
        id: Uuid::now_v7(),
        session_id,
        seq,
        turn_id,
        event_type: event_type.to_owned(),
        payload,
        created_at: now_ms(),
    };
    sqlx::query(
        "INSERT INTO session_events(id, session_id, seq, turn_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event.id.to_string())
    .bind(session_id.to_string())
    .bind(event.seq)
    .bind(event.turn_id.map(|id| id.to_string()))
    .bind(&event.event_type)
    .bind(serde_json::to_string(&event.payload)?)
    .bind(event.created_at)
    .execute(&mut **transaction)
    .await?;
    if event.event_type == "context.usage_updated" {
        sqlx::query("UPDATE sessions SET context_usage_json = ? WHERE id = ?")
            .bind(serde_json::to_string(&event.payload)?)
            .bind(session_id.to_string())
            .execute(&mut **transaction)
            .await?;
    }
    record_runtime_metrics_tx(transaction, &event).await?;
    Ok(event)
}

async fn increment_runtime_metric(
    transaction: &mut Transaction<'_, Sqlite>,
    metric: &str,
    delta: i64,
) -> Result<(), StoreError> {
    if delta <= 0 {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO runtime_metric_totals(metric, value) VALUES (?, ?)
         ON CONFLICT(metric) DO UPDATE SET value = value + excluded.value",
    )
    .bind(metric)
    .bind(delta)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn record_runtime_metrics_tx(
    transaction: &mut Transaction<'_, Sqlite>,
    event: &EventRecord,
) -> Result<(), StoreError> {
    let Some(turn_id) = event.turn_id else {
        if event.event_type == "agent.model_retry" {
            increment_runtime_metric(transaction, "provider_retries_total", 1).await?;
        }
        return Ok(());
    };
    let session_id = event.session_id.to_string();
    let turn_id = turn_id.to_string();
    match event.event_type.as_str() {
        "turn.started" => {
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO runtime_metric_turns(session_id, turn_id, started_at)
                 VALUES (?, ?, ?)",
            )
            .bind(&session_id)
            .bind(&turn_id)
            .bind(event.created_at)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if inserted > 0 {
                increment_runtime_metric(transaction, "turns_started_total", 1).await?;
            }
        }
        "agent.message_update" | "agent.message_end"
            if event.payload["message"]["role"].as_str() == Some("assistant") =>
        {
            let started_at = sqlx::query_scalar::<_, i64>(
                "UPDATE runtime_metric_turns SET first_response_at = ?
                 WHERE session_id = ? AND turn_id = ? AND first_response_at IS NULL
                 RETURNING started_at",
            )
            .bind(event.created_at)
            .bind(&session_id)
            .bind(&turn_id)
            .fetch_optional(&mut **transaction)
            .await?;
            if let Some(started_at) = started_at {
                increment_runtime_metric(transaction, "first_token_samples_total", 1).await?;
                increment_runtime_metric(
                    transaction,
                    "first_token_duration_ms_total",
                    event.created_at.saturating_sub(started_at),
                )
                .await?;
            }
        }
        "turn.completed" | "turn.failed" => {
            let started_at = sqlx::query_scalar::<_, i64>(
                "DELETE FROM runtime_metric_turns WHERE session_id = ? AND turn_id = ?
                 RETURNING started_at",
            )
            .bind(&session_id)
            .bind(&turn_id)
            .fetch_optional(&mut **transaction)
            .await?;
            if let Some(started_at) = started_at {
                let metric = if event.event_type == "turn.completed" {
                    "turns_completed_total"
                } else {
                    "turns_failed_total"
                };
                increment_runtime_metric(transaction, metric, 1).await?;
                increment_runtime_metric(transaction, "turn_duration_samples_total", 1).await?;
                increment_runtime_metric(
                    transaction,
                    "turn_duration_ms_total",
                    event.created_at.saturating_sub(started_at),
                )
                .await?;
            }
        }
        "agent.model_retry" => {
            increment_runtime_metric(transaction, "provider_retries_total", 1).await?;
        }
        "agent.tool_execution_start" => {
            let Some(tool_call_id) = event.payload.get("toolCallId").and_then(Value::as_str) else {
                return Ok(());
            };
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO runtime_metric_tool_calls(
                    session_id, turn_id, tool_call_id, started_at
                 ) VALUES (?, ?, ?, ?)",
            )
            .bind(&session_id)
            .bind(&turn_id)
            .bind(tool_call_id)
            .bind(event.created_at)
            .execute(&mut **transaction)
            .await?
            .rows_affected();
            if inserted > 0 {
                increment_runtime_metric(transaction, "tool_calls_started_total", 1).await?;
            }
        }
        "agent.tool_execution_end" => {
            let Some(tool_call_id) = event.payload.get("toolCallId").and_then(Value::as_str) else {
                return Ok(());
            };
            let started_at = sqlx::query_scalar::<_, i64>(
                "DELETE FROM runtime_metric_tool_calls
                 WHERE session_id = ? AND turn_id = ? AND tool_call_id = ?
                 RETURNING started_at",
            )
            .bind(&session_id)
            .bind(&turn_id)
            .bind(tool_call_id)
            .fetch_optional(&mut **transaction)
            .await?;
            if let Some(started_at) = started_at {
                increment_runtime_metric(transaction, "tool_calls_completed_total", 1).await?;
                if event.payload.get("isError").and_then(Value::as_bool) == Some(true) {
                    increment_runtime_metric(transaction, "tool_calls_failed_total", 1).await?;
                }
                increment_runtime_metric(transaction, "tool_duration_samples_total", 1).await?;
                increment_runtime_metric(
                    transaction,
                    "tool_duration_ms_total",
                    event.created_at.saturating_sub(started_at),
                )
                .await?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn workspace_state_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<WorkspaceStateRecord, StoreError> {
    Ok(WorkspaceStateRecord {
        current_path: row.try_get("current_path")?,
        pending_path: row.try_get("pending_path")?,
        pending_session_id: row
            .try_get::<Option<String>, _>("pending_session_id")?
            .map(|value| value.parse())
            .transpose()?,
        requested_at: row.try_get("requested_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn session_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<SessionRecord, StoreError> {
    Ok(SessionRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        title: row.try_get("title")?,
        title_source: row.try_get("title_source")?,
        status: SessionStatus::parse(row.try_get("status")?),
        runtime_origin: SessionRuntimeOrigin::parse(row.try_get("runtime_origin")?),
        participants: serde_json::from_str(&row.try_get::<String, _>("participants_json")?)?,
        environment: serde_json::from_str(&row.try_get::<String, _>("environment_json")?)?,
        context_usage: row
            .try_get::<Option<String>, _>("context_usage_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn normalize_session_title(title: &str) -> Result<String, StoreError> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(StoreError::InvalidValue(
            "session title cannot be empty".to_owned(),
        ));
    }
    Ok(title.chars().take(50).collect())
}

fn input_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<InputRecord, StoreError> {
    Ok(InputRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        turn_id: row.try_get::<String, _>("turn_id")?.parse()?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        state: InputState::parse(row.try_get("state")?),
        created_at: row.try_get("created_at")?,
        claimed_at: row.try_get("claimed_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

fn event_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<EventRecord, StoreError> {
    Ok(EventRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        seq: row.try_get("seq")?,
        turn_id: row
            .try_get::<Option<String>, _>("turn_id")?
            .map(|id| id.parse())
            .transpose()?,
        event_type: row.try_get("event_type")?,
        payload: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        created_at: row.try_get("created_at")?,
    })
}

fn permission_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<PermissionRecord, StoreError> {
    Ok(PermissionRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        turn_id: row.try_get::<String, _>("turn_id")?.parse()?,
        operation_id: row.try_get::<String, _>("operation_id")?.parse()?,
        capability: row.try_get("capability")?,
        resource: row.try_get("resource")?,
        state: PermissionState::parse(row.try_get("state")?),
        request: serde_json::from_str(&row.try_get::<String, _>("request_json")?)?,
        decision: row
            .try_get::<Option<String>, _>("decision_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

fn question_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<QuestionRecord, StoreError> {
    Ok(QuestionRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        turn_id: row.try_get::<String, _>("turn_id")?.parse()?,
        state: QuestionState::parse(row.try_get("state")?),
        questions: serde_json::from_str(&row.try_get::<String, _>("questions_json")?)?,
        answers: row
            .try_get::<Option<String>, _>("answers_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

fn blob_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<BlobRecord, StoreError> {
    Ok(BlobRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        sha256: row.try_get("sha256")?,
        mime: row.try_get("mime")?,
        byte_length: row.try_get("byte_length")?,
        storage_path: row.try_get("storage_path")?,
        created_at: row.try_get("created_at")?,
    })
}

fn voice_speech_segment_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<VoiceSpeechSegmentRecord, StoreError> {
    Ok(VoiceSpeechSegmentRecord {
        id: row.try_get("id")?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        external_message_id: row.try_get("external_message_id")?,
        external_audio_asset_id: row.try_get("external_audio_asset_id")?,
        audio_blob_id: row.try_get::<String, _>("audio_blob_id")?.parse()?,
        duration_ms: row.try_get("duration_ms")?,
        audio_format: row.try_get("audio_format")?,
        segment_group_id: row.try_get("segment_group_id")?,
        group_index: row.try_get("group_index")?,
        sequence: row.try_get("sequence")?,
        text_hash: row.try_get("text_hash")?,
        text_length: row.try_get("text_length")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn agent_thread_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<AgentThreadRecord, StoreError> {
    Ok(AgentThreadRecord {
        id: row.try_get::<String, _>("id")?.parse()?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        parent_id: row
            .try_get::<Option<String>, _>("parent_id")?
            .map(|id| id.parse())
            .transpose()?,
        agent_path: row.try_get("agent_path")?,
        task_name: row.try_get("task_name")?,
        role: row.try_get("role")?,
        prompt: row.try_get("prompt")?,
        status: row.try_get("status")?,
        context: row
            .try_get::<Option<String>, _>("context_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        result: row
            .try_get::<Option<String>, _>("result_json")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        started_at: row.try_get("started_at")?,
        completed_at: row.try_get("completed_at")?,
        config: serde_json::from_str(&row.try_get::<String, _>("config_json")?)?,
        usage: serde_json::from_str(&row.try_get::<String, _>("usage_json")?)?,
        deadline_at: row.try_get("deadline_at")?,
        coordination_batch_id: row.try_get("coordination_batch_id")?,
    })
}

fn agent_mailbox_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<AgentMailboxRecord, StoreError> {
    Ok(AgentMailboxRecord {
        id: Uuid::parse_str(&row.try_get::<String, _>("id")?)?,
        session_id: row.try_get::<String, _>("session_id")?.parse()?,
        sender_path: row.try_get("sender_path")?,
        target_path: row.try_get("target_path")?,
        content: row.try_get("content")?,
        kind: row.try_get("kind")?,
        trigger_turn: row.try_get("trigger_turn")?,
        details: serde_json::from_str(&row.try_get::<String, _>("details_json")?)?,
        created_at: row.try_get("created_at")?,
        consumed_at: row.try_get("consumed_at")?,
    })
}

async fn get_agent_thread_tx(
    transaction: &mut Transaction<'_, Sqlite>,
    id: AgentId,
) -> Result<AgentThreadRecord, StoreError> {
    let row = sqlx::query(
        "SELECT id, session_id, parent_id, agent_path, task_name, role, prompt, status,
                context_json, result_json, error, created_at, updated_at, started_at, completed_at,
                config_json, usage_json, deadline_at, coordination_batch_id
         FROM agent_threads WHERE id = ?",
    )
    .bind(id.to_string())
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StoreError::AgentNotFound(id))?;
    agent_thread_from_row(&row)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn file_store_reads_are_not_starved_by_an_active_writer() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::open(directory.path().join("store.db"))
            .await
            .expect("store");
        store
            .initialize_workspace_state("/workspace")
            .await
            .expect("workspace state");

        let mut writer = store
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .expect("writer transaction");
        sqlx::query("UPDATE workspace_state SET updated_at = updated_at + 1 WHERE singleton = 1")
            .execute(&mut *writer)
            .await
            .expect("writer update");

        let state = tokio::time::timeout(Duration::from_secs(1), store.workspace_state())
            .await
            .expect("read should not wait for the writer")
            .expect("workspace state");
        assert_eq!(state.current_path, "/workspace");
        writer.rollback().await.expect("rollback");
    }

    #[tokio::test]
    async fn input_is_durable_before_it_can_be_claimed() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("test").await.expect("session");
        let enqueued = store
            .enqueue_input(session.id, TurnId::new(), json!({"text": "hello"}))
            .await
            .expect("enqueue");
        assert!(store.has_pending_input(session.id).await.expect("pending"));
        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "input.admitted");

        let claimed = store
            .claim_next_input(session.id)
            .await
            .expect("claim")
            .expect("input");
        assert_eq!(claimed.id, enqueued.input.id);
        assert_eq!(claimed.state, InputState::Claimed);
        assert!(store.has_pending_input(session.id).await.expect("claimed"));
        store.complete_input(&claimed).await.expect("complete");
        assert!(
            !store
                .has_pending_input(session.id)
                .await
                .expect("completed")
        );

        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(
            events.last().expect("last event").event_type,
            "input.completed"
        );
    }

    #[tokio::test]
    async fn core_sync_outbox_retries_durably_without_storing_credentials() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("sync").await.expect("session");
        store
            .set_core_session_identity(
                session.id,
                "https://core.example",
                "user-7",
                "credential-ref-7",
            )
            .await
            .expect("identity");
        let queued = store
            .enqueue_core_sync(
                session.id,
                "credential-ref-7",
                "session",
                &format!("session:{}", session.id),
                json!({"title":"sync"}),
            )
            .await
            .expect("enqueue");
        assert_eq!(queued.state, "queued");
        let claimed = store.claim_core_sync(10, 30_000).await.expect("claim");
        assert_eq!(claimed.len(), 1);
        store
            .retry_core_sync(claimed[0].id, "offline", 0)
            .await
            .expect("retry");
        let retried = store.claim_core_sync(10, 30_000).await.expect("reclaim");
        assert_eq!(retried[0].attempts, 1);
        store
            .complete_core_sync(retried[0].id)
            .await
            .expect("complete");
        let encoded = serde_json::to_string(
            &store
                .list_core_session_identities()
                .await
                .expect("identities"),
        )
        .expect("encode");
        assert!(!encoded.contains("secret-token"));
        assert_eq!(
            store
                .list_core_sync_outbox(Some("completed"), 10)
                .await
                .expect("completed")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn recovery_requeues_claimed_inputs() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("recovery").await.expect("session");
        store
            .enqueue_input(session.id, TurnId::new(), json!({"text": "resume"}))
            .await
            .expect("enqueue");
        let claimed = store
            .claim_next_input(session.id)
            .await
            .expect("claim")
            .expect("input");
        assert_eq!(claimed.state, InputState::Claimed);
        assert_eq!(store.recover_claimed_inputs().await.expect("recover"), 1);
        assert!(
            store
                .claim_next_input(session.id)
                .await
                .expect("claim again")
                .is_some()
        );
    }

    #[tokio::test]
    async fn durable_job_dispatch_is_idempotent_and_requeues_failure() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("job").await.expect("session");
        let job = store
            .schedule_job("test", Some(session.id), 0, json!({}), "job-input-test")
            .await
            .expect("schedule");
        let payload = json!({"text":"run","jobId":job.id});
        assert!(
            store
                .enqueue_job_input(session.id, TurnId::new(), job.id, payload.clone())
                .await
                .expect("first dispatch")
                .is_some()
        );
        assert!(
            store
                .enqueue_job_input(session.id, TurnId::new(), job.id, payload.clone())
                .await
                .expect("duplicate dispatch")
                .is_none()
        );
        let claimed = store
            .claim_next_input(session.id)
            .await
            .expect("claim")
            .expect("input");
        store
            .interrupt_input(&claimed, "retry")
            .await
            .expect("interrupt");
        assert!(
            store
                .enqueue_job_input(session.id, TurnId::new(), job.id, payload)
                .await
                .expect("retry dispatch")
                .is_some()
        );
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM session_inputs WHERE json_extract(payload_json, '$.jobId')=?",
        )
        .bind(job.id.to_string())
        .fetch_one(store.pool())
        .await
        .expect("count");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn duplicate_schedule_does_not_reset_a_claimed_job() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("claimed job").await.expect("session");
        let job = store
            .schedule_job(
                "test",
                Some(session.id),
                0,
                json!({"attempt": 1}),
                "job-claimed-test",
            )
            .await
            .expect("schedule");
        let claimed = store.claim_due_jobs(1, 30_000).await.expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, job.id);
        assert_eq!(claimed[0].state, "claimed");

        let duplicate = store
            .schedule_job(
                "test",
                Some(session.id),
                60_000,
                json!({"attempt": 2}),
                "job-claimed-test",
            )
            .await
            .expect("duplicate schedule");

        assert_eq!(duplicate.id, job.id);
        assert_eq!(duplicate.state, "claimed");
        assert_eq!(duplicate.due_at, 0);
        assert_eq!(duplicate.payload, json!({"attempt": 1}));
        assert!(
            store
                .claim_due_jobs(1, 30_000)
                .await
                .expect("claimed lease remains active")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn self_awake_completion_is_atomic_and_next_wake_is_idempotent() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("self awake").await.expect("session");
        let job = store
            .schedule_job(
                "self_awake",
                Some(session.id),
                0,
                json!({"trigger":{"type":"manual"}}),
                "self-awake:first",
            )
            .await
            .expect("schedule");
        assert_eq!(
            store
                .get_self_awake_run_by_job(job.id)
                .await
                .expect("pending run")
                .status,
            "pending"
        );
        let run = store
            .start_self_awake_run(
                &job,
                "self-awake.v1",
                "manual:1",
                json!({"schema_version":"self-awake.v1"}),
                json!({"assistantId":"a1","characterId":"c1"}),
            )
            .await
            .expect("start");
        let next = (
            60_000,
            json!({"trigger":{"type":"scheduled"}}),
            "self-awake:next".to_owned(),
        );
        let next_job = store
            .complete_self_awake_run(
                &run,
                json!({"action":"write_diary"}),
                Some(json!({"title":"观察","content":"一切正常","mood":"calm"})),
                Some(json!({"title":"提醒","message":"测试","channel":"auto"})),
                Some(next.clone()),
            )
            .await
            .expect("complete")
            .expect("next job");
        assert_eq!(
            store.get_job(job.id).await.expect("current job").state,
            "completed"
        );
        assert_eq!(next_job.state, "scheduled");
        assert_eq!(
            store
                .get_self_awake_run_by_job(next_job.id)
                .await
                .expect("next pending run")
                .status,
            "pending"
        );
        assert_eq!(
            store
                .get_self_awake_run_by_job(job.id)
                .await
                .expect("run")
                .status,
            "completed"
        );
        assert_eq!(
            store
                .list_self_awake_diaries(session.id, 10)
                .await
                .expect("diaries")
                .len(),
            1
        );
        let duplicate_next = store
            .complete_self_awake_run(
                &run,
                json!({"action":"write_diary"}),
                Some(json!({"title":"重复","content":"不应重复"})),
                None,
                Some(next),
            )
            .await
            .expect("repeat completion")
            .expect("same next job");
        assert_eq!(duplicate_next.id, next_job.id);
        assert_eq!(
            store
                .list_self_awake_diaries(session.id, 10)
                .await
                .expect("diaries")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn bound_connector_event_schedules_self_awake_with_history() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session("connector awake")
            .await
            .expect("session");
        let connector = store
            .register_connector(
                "test",
                "device-1",
                "Test",
                "disconnected",
                json!({"boundSessionId":session.id,"selfAwakeOnEvent":true}),
            )
            .await
            .expect("connector");
        let event = store
            .publish_connector_event(
                connector.id,
                "external-1",
                "test.changed",
                json!({
                    "value":42,
                    "conversationHistory":[{"role":"user","content":"刚才的状态"}]
                }),
            )
            .await
            .expect("event");
        let jobs = store.list_jobs(Some("self_awake"), 10).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].session_id, Some(session.id));
        assert_eq!(jobs[0].payload["trigger"]["eventId"], event.id.to_string());
        assert_eq!(
            jobs[0].payload["conversationHistory"][0]["content"],
            "刚才的状态"
        );
    }

    #[tokio::test]
    async fn file_store_survives_reopen() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("agent.db");
        let session_id = {
            let store = Store::open(&path).await.expect("open");
            let session = store.create_session("persisted").await.expect("session");
            store
                .append_event(session.id, None, "session.created", json!({}))
                .await
                .expect("event");
            session.id
        };
        let reopened = Store::open(&path).await.expect("reopen");
        assert_eq!(
            reopened
                .get_session(session_id)
                .await
                .expect("session")
                .title,
            "persisted"
        );
        assert_eq!(
            reopened
                .list_events(session_id, 0)
                .await
                .expect("events")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn file_store_serializes_concurrent_runtime_writes_without_busy_errors() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::open(directory.path().join("concurrent.db"))
            .await
            .expect("store");
        let session = store.create_session("concurrent").await.expect("session");
        let mut writes = tokio::task::JoinSet::new();
        for index in 0..64 {
            let store = store.clone();
            writes.spawn(async move {
                store
                    .append_event(session.id, None, "test.concurrent", json!({"index":index}))
                    .await
            });
        }
        while let Some(result) = writes.join_next().await {
            result.expect("join").expect("concurrent write");
        }
        assert_eq!(
            store
                .list_events(session.id, 0)
                .await
                .expect("events")
                .iter()
                .filter(|event| event.event_type == "test.concurrent")
                .count(),
            64
        );
    }

    #[tokio::test]
    async fn reopen_marks_inflight_operation_unknown_without_replaying_it() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("operations.db");
        let (operation_id, committed_id) = {
            let store = Store::open(&path).await.expect("open");
            let session = store.create_session("operations").await.expect("session");
            let turn = TurnId::new();
            let operation = OperationId::new();
            store
                .plan_operation(
                    operation,
                    session.id,
                    turn,
                    "call-1",
                    "write_file",
                    "workspace.write",
                    "README.md",
                    json!({"path":"README.md"}),
                )
                .await
                .expect("plan");
            store
                .transition_operation(operation, "started", None, None)
                .await
                .expect("start");
            let committed = OperationId::new();
            store
                .plan_operation(
                    committed,
                    session.id,
                    turn,
                    "call-2",
                    "read_file",
                    "workspace.read",
                    "README.md",
                    json!({"path":"README.md"}),
                )
                .await
                .expect("plan committed");
            store
                .transition_operation(committed, "committed", Some(json!({"success":true})), None)
                .await
                .expect("commit");
            (operation, committed)
        };
        let reopened = Store::open(&path).await.expect("reopen");
        assert_eq!(
            reopened
                .get_operation(operation_id)
                .await
                .expect("unknown")
                .state,
            "unknown"
        );
        assert_eq!(
            reopened
                .get_operation(committed_id)
                .await
                .expect("committed")
                .state,
            "committed"
        );
        assert_eq!(
            reopened
                .resolve_unknown_operation(operation_id, "retry")
                .await
                .expect("resolve retry")
                .state,
            "failed"
        );
    }

    #[tokio::test]
    async fn permission_decision_is_persisted_before_resolution_event() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("permission").await.expect("session");
        let turn_id = TurnId::new();
        let request_id = PermissionRequestId::new();
        store
            .create_permission(
                request_id,
                session.id,
                turn_id,
                OperationId::new(),
                "workspace.write",
                "README.md",
                json!({"tool": "write"}),
            )
            .await
            .expect("create permission");
        assert_eq!(
            store
                .list_pending_permissions(Some(session.id))
                .await
                .expect("pending")
                .len(),
            1
        );
        let resolved = store
            .resolve_permission(request_id, "once", json!({"decision": "once"}))
            .await
            .expect("resolve");
        assert_eq!(resolved.permission.state, PermissionState::Allowed);
        assert!(
            store
                .list_pending_permissions(Some(session.id))
                .await
                .expect("pending")
                .is_empty()
        );
        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(events[0].event_type, "permission.requested");
        assert_eq!(events[1].event_type, "permission.resolved");
    }

    #[tokio::test]
    async fn host_records_and_leases_are_durable() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("host").await.expect("session");
        let memo = store
            .create_memo(MemoInput {
                title: "wake".to_owned(),
                kind: "reminder".to_owned(),
                remind_at: Some(1),
                related_session_id: session.id.to_string(),
                ..MemoInput::default()
            })
            .await
            .expect("memo");
        let job = store
            .schedule_job(
                "memo.reminder",
                Some(session.id),
                1,
                json!({"memoId":memo.id}),
                "memo:test",
            )
            .await
            .expect("job");
        let claimed = store.claim_due_jobs(10, 30_000).await.expect("claim");
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, job.id);
        assert!(
            store
                .claim_due_jobs(10, 30_000)
                .await
                .expect("leased")
                .is_empty()
        );
        assert_eq!(
            store
                .recover_claimed_jobs()
                .await
                .expect("recover previous process lease"),
            1
        );
        let reclaimed = store
            .claim_due_jobs(10, 30_000)
            .await
            .expect("reclaim after restart");
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].id, job.id);
        assert_eq!(reclaimed[0].attempts, 2);
        store.complete_job(job.id).await.expect("complete");
        assert_eq!(
            store.get_job(job.id).await.expect("job state").state,
            "completed"
        );
        assert_eq!(
            store
                .next_memo_wake(0)
                .await
                .expect("next memo")
                .expect("scheduled memo")
                .id,
            memo.id
        );
    }

    #[tokio::test]
    async fn only_legacy_credential_blocked_handoffs_are_recovered() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session("handoff recovery")
            .await
            .expect("session");
        let recoverable = store
            .schedule_assistant_handoff(
                session.id,
                TurnId::new(),
                json!({"assistantId":2,"participant":{"assistantId":2}}),
                "handoff:recoverable",
            )
            .await
            .expect("recoverable handoff");
        let terminal = store
            .schedule_assistant_handoff(
                session.id,
                TurnId::new(),
                json!({"assistantId":3,"participant":{"assistantId":3}}),
                "handoff:terminal",
            )
            .await
            .expect("terminal handoff");
        let claimed = store.claim_due_jobs(10, 30_000).await.expect("claim");
        assert_eq!(claimed.len(), 2);
        store
            .fail_job(
                recoverable.id,
                "assistant handoff requires MON_CORE_BASE_URL",
                None,
            )
            .await
            .expect("fail legacy handoff");
        store
            .fail_job(terminal.id, "target model is unavailable", None)
            .await
            .expect("fail terminal handoff");

        assert_eq!(
            store
                .recover_legacy_credential_blocked_assistant_handoffs()
                .await
                .expect("recover"),
            1
        );
        let recovered = store.get_job(recoverable.id).await.expect("recovered job");
        assert_eq!(recovered.state, "scheduled");
        assert_eq!(recovered.attempts, 0);
        assert_eq!(
            store
                .get_job(terminal.id)
                .await
                .expect("terminal job")
                .state,
            "failed"
        );
    }

    #[tokio::test]
    async fn session_environment_is_durable_bounded_and_evented() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_environment(
                "environment",
                Vec::new(),
                json!({"timezone":"Asia/Shanghai","locale":"zh-CN","location":{"city":"上海"}}),
            )
            .await
            .expect("session");
        assert_eq!(session.environment["location"]["city"], "上海");
        let updated = store
            .set_session_environment(
                session.id,
                json!({"timezone":"Asia/Tokyo","locale":"ja-JP","location":{"city":"东京"}}),
            )
            .await
            .expect("update environment");
        assert_eq!(updated.environment["timezone"], "Asia/Tokyo");
        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "session.environment_updated");
        assert!(
            store
                .set_session_environment(session.id, json!({"value":"x".repeat(17 * 1024)}))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn session_participants_are_persisted_and_emit_an_event() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("participants").await.expect("session");
        store
            .set_session_model_binding(session.id, "1", "11", None, json!({"id":"old"}))
            .await
            .expect("session model binding");
        store
            .set_session_actor_model_binding(session.id, "1", "12", None, json!({"id":"actor"}))
            .await
            .expect("actor model binding");
        let updated = store
            .set_session_participants(
                session.id,
                vec![json!({"assistantId":7,"assistantName":"Yuki","position":0})],
            )
            .await
            .expect("participants");
        assert_eq!(updated.participants[0]["assistantId"], 7);
        assert_eq!(
            store
                .get_session(session.id)
                .await
                .expect("reload")
                .participants,
            updated.participants
        );
        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(
            events.last().expect("participant event").event_type,
            "session.participants_updated"
        );
        assert_eq!(
            events.last().expect("participant event").payload["modelBindingsReset"],
            true
        );
        assert!(
            store
                .get_session_model_binding(session.id)
                .await
                .expect("session model binding")
                .is_none()
        );
        assert!(
            store
                .list_session_actor_model_bindings(Some(session.id))
                .await
                .expect("actor model bindings")
                .is_empty()
        );
        store
            .set_session_model_binding(session.id, "7", "17", None, json!({"id":"busy"}))
            .await
            .expect("busy model binding");
        let enqueued = store
            .enqueue_input(session.id, TurnId::new(), json!({"text":"busy"}))
            .await
            .expect("input");
        assert!(
            store
                .set_session_participants(session.id, vec![json!({"assistantId":8})])
                .await
                .is_err()
        );
        assert!(
            store
                .get_session_model_binding(session.id)
                .await
                .expect("preserved busy binding")
                .is_some()
        );
        let input = store
            .claim_next_input(session.id)
            .await
            .expect("claim")
            .expect("queued input");
        assert_eq!(input.id, enqueued.input.id);
        store.complete_input(&input).await.expect("complete input");
    }

    #[tokio::test]
    async fn durable_assistant_handoff_gates_queued_inputs_until_identity_is_replaced() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_participants(
                "handoff",
                vec![json!({"assistantId":1,"assistantName":"One"})],
            )
            .await
            .expect("session");
        let queued = store
            .enqueue_input(
                session.id,
                TurnId::new(),
                json!({"text":"queued user input"}),
            )
            .await
            .expect("queued input");
        let source_turn = TurnId::new();
        let handoff_payload =
            json!({"assistantId":2,"participant":{"assistantId":2,"assistantName":"Two"}});
        let job = store
            .schedule_assistant_handoff(
                session.id,
                source_turn,
                handoff_payload.clone(),
                "assistant-handoff:test",
            )
            .await
            .expect("handoff job");
        let retried = store
            .schedule_assistant_handoff(
                session.id,
                source_turn,
                handoff_payload,
                "assistant-handoff:test",
            )
            .await
            .expect("idempotent handoff request");
        assert_eq!(retried.id, job.id);
        assert_eq!(
            store
                .list_events(session.id, 0)
                .await
                .expect("request events")
                .iter()
                .filter(|event| event.event_type == "session.assistant_handoff.requested")
                .count(),
            1
        );
        assert!(
            store
                .claim_next_input(session.id)
                .await
                .expect("gated claim")
                .is_none()
        );
        assert_eq!(
            store
                .claim_due_jobs(1, 30_000)
                .await
                .expect("claim job")
                .len(),
            1
        );
        assert!(
            store
                .claim_next_input(session.id)
                .await
                .expect("claimed handoff gate")
                .is_none()
        );

        store
            .commit_assistant_handoff(
                job.id,
                session.id,
                json!({"assistantId":2,"assistantName":"Two"}),
                "2",
                "model-2",
                Some("vision-2"),
                json!({"id":"model-2","apiKey":"not persisted"}),
                json!({"id":"actor-model-2","apiKey":"not persisted"}),
                "internal handoff",
            )
            .await
            .expect("commit handoff with queued input");
        assert_eq!(
            store.get_job(job.id).await.expect("completed job").state,
            "completed"
        );
        let first = store
            .claim_next_input(session.id)
            .await
            .expect("ungated claim")
            .expect("queued input");
        assert_eq!(first.id, queued.input.id);
        assert_eq!(
            store
                .get_session(session.id)
                .await
                .expect("updated session")
                .participants[0]["assistantId"],
            2
        );
        let binding = store
            .get_session_model_binding(session.id)
            .await
            .expect("model binding")
            .expect("bound model");
        assert_eq!(binding.ai_entity_id, "model-2");
        assert!(binding.runtime_info.get("apiKey").is_none());
        let events = store.list_events(session.id, 0).await.expect("events");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "session.assistant_handoff.completed")
        );
    }

    #[tokio::test]
    async fn durable_assistant_handoff_enqueues_one_internal_target_run_when_idle() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_participants("idle handoff", vec![json!({"assistantId":"one"})])
            .await
            .expect("session");
        let job = store
            .schedule_assistant_handoff(
                session.id,
                TurnId::new(),
                json!({
                    "assistantId":"two",
                    "participant":{"assistantId":"two"},
                    "sourceParticipant":{"assistantId":"one"},
                }),
                "assistant-handoff:idle",
            )
            .await
            .expect("handoff job");
        store
            .claim_due_jobs(1, 30_000)
            .await
            .expect("claim handoff");
        let committed = store
            .commit_assistant_handoff(
                job.id,
                session.id,
                json!({"assistantId":"two"}),
                "two",
                "model-two",
                None,
                json!({"id":"model-two"}),
                json!({"id":"actor-model-two"}),
                "internal continuation",
            )
            .await
            .expect("commit handoff");
        assert!(committed.target_run_enqueued);
        assert!(!committed.queued_input_resumed);
        let input = store
            .claim_next_input(session.id)
            .await
            .expect("claim internal target run")
            .expect("internal target run");
        assert_eq!(input.payload["internalHandoff"], true);
        assert_eq!(input.payload["jobId"], job.id.to_string());
        assert_eq!(input.payload["text"], "internal continuation");
        assert!(
            store
                .claim_next_input(session.id)
                .await
                .expect("no duplicate target run")
                .is_none()
        );
    }

    #[tokio::test]
    async fn session_model_binding_persists_without_credentials() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("models").await.expect("session");
        let binding = store
            .set_session_model_binding(
                session.id,
                "3",
                "7",
                Some("9"),
                json!({"id":"model-a","apiKey":"must-not-be-stored"}),
            )
            .await
            .expect("binding");
        assert_eq!(binding.ai_entity_id, "7");
        assert_eq!(binding.vision_ai_entity_id.as_deref(), Some("9"));

        let loaded = store
            .get_session_model_binding(session.id)
            .await
            .expect("load")
            .expect("stored binding");
        assert_eq!(loaded.assistant_id, "3");
        assert_eq!(loaded.runtime_info["id"], "model-a");
        assert!(loaded.runtime_info.get("apiKey").is_none());
        assert!(
            !loaded
                .runtime_info
                .to_string()
                .contains("must-not-be-stored")
        );
        let actor = store
            .set_session_actor_model_binding(
                session.id,
                "4",
                "8",
                Some("10"),
                json!({"id":"actor-model","api_key":"actor-secret"}),
            )
            .await
            .expect("actor binding");
        assert_eq!(actor.assistant_id, "4");
        assert_eq!(actor.runtime_info["id"], "actor-model");
        assert!(!actor.runtime_info.to_string().contains("actor-secret"));
    }

    #[tokio::test]
    async fn agent_mailbox_is_fifo_and_consumed_explicitly() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("agents").await.expect("session");
        let first = store
            .enqueue_agent_message(
                session.id,
                "/root",
                "/root/child",
                "one",
                "message",
                false,
                json!({}),
            )
            .await
            .expect("first");
        let second = store
            .enqueue_agent_message(
                session.id,
                "/root",
                "/root/child",
                "two",
                "followup",
                true,
                json!({}),
            )
            .await
            .expect("second");
        let pending = store
            .pending_agent_messages(session.id, "/root/child")
            .await
            .expect("pending");
        assert_eq!(
            pending
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        store
            .consume_agent_messages(&[first.id, second.id])
            .await
            .expect("consume");
        assert!(
            store
                .pending_agent_messages(session.id, "/root/child")
                .await
                .expect("empty")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn workspace_switch_is_durable_idempotent_and_waits_for_runtime_idle() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("workspace").await.expect("session");
        let initial = store
            .initialize_workspace_state("C:/initial")
            .await
            .expect("initialize");
        assert_eq!(initial.current_path, "C:/initial");
        let pending = store
            .request_workspace_switch(session.id, "C:/next")
            .await
            .expect("request");
        assert_eq!(pending.pending_path.as_deref(), Some("C:/next"));
        assert_eq!(
            store
                .request_workspace_switch(session.id, "C:/next")
                .await
                .expect("idempotent")
                .requested_at,
            pending.requested_at
        );
        assert!(store.workspace_runtime_is_idle().await.expect("idle"));
        store
            .enqueue_input(session.id, TurnId::new(), json!({"text":"queued"}))
            .await
            .expect("input");
        assert!(!store.workspace_runtime_is_idle().await.expect("busy"));
        let input = store
            .claim_next_input(session.id)
            .await
            .expect("claim")
            .expect("input");
        store.complete_input(&input).await.expect("complete input");
        let applied = store
            .complete_workspace_switch("C:/next")
            .await
            .expect("apply");
        assert_eq!(applied.current_path, "C:/next");
        assert!(applied.pending_path.is_none());
        assert!(
            store
                .list_events(session.id, 0)
                .await
                .expect("events")
                .iter()
                .any(|event| event.event_type == "workspace.changed")
        );
    }

    #[tokio::test]
    async fn session_titles_are_bounded_generated_once_and_user_owned() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("").await.expect("session");
        assert_eq!(session.title, "新会话");
        assert_eq!(session.title_source, "pending");
        assert!(
            store
                .claim_session_title_generation(session.id)
                .await
                .expect("claim")
        );
        let generated = store
            .set_session_title(session.id, "  自动   标题  ", "generated")
            .await
            .expect("generated title");
        assert_eq!(generated.title, "自动 标题");
        let user = store
            .set_session_title(session.id, "用户标题", "user")
            .await
            .expect("user title");
        assert_eq!(user.title_source, "user");
        let preserved = store
            .set_session_title(session.id, "不应覆盖", "generated")
            .await
            .expect("preserved title");
        assert_eq!(preserved.title, "用户标题");
    }

    #[tokio::test]
    async fn session_listing_hides_closed_and_delete_rejects_active_work() {
        let store = Store::in_memory().await.expect("store");
        let active = store.create_session("active").await.expect("active");
        let closed = store.create_session("closed").await.expect("closed");
        store.close_session(closed.id).await.expect("close");
        assert_eq!(store.list_sessions().await.expect("active list").len(), 1);
        assert_eq!(
            store
                .list_sessions_including_closed()
                .await
                .expect("full list")
                .len(),
            2
        );
        store
            .enqueue_input(active.id, TurnId::new(), json!({"text":"busy"}))
            .await
            .expect("input");
        assert!(store.begin_session_deletion(active.id).await.is_err());
        let input = store
            .claim_next_input(active.id)
            .await
            .expect("claim")
            .expect("input");
        store.complete_input(&input).await.expect("complete");
        assert!(
            store
                .begin_session_deletion(active.id)
                .await
                .expect("begin delete")
        );
        let mut events = store.subscribe();
        assert!(store.delete_session(active.id).await.expect("delete"));
        let deleted = events.recv().await.expect("delete tombstone");
        assert_eq!(deleted.event_type, "session.deleted");
        assert_eq!(deleted.session_id, active.id);
        assert!(matches!(
            store.get_session(active.id).await,
            Err(StoreError::SessionNotFound(_))
        ));
    }

    #[tokio::test]
    async fn context_usage_events_materialize_on_the_session_record() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("usage").await.expect("session");
        let usage = json!({
            "contextTokens":321,
            "tokenBreakdown":{
                "character":11,
                "skills":12,
                "system":13,
                "tools":14,
                "history":271,
                "cacheRead":128,
                "cacheMiss":64,
                "cacheHitRate":0.6666666667
            }
        });
        store
            .append_event(
                session.id,
                Some(TurnId::new()),
                "context.usage_updated",
                usage.clone(),
            )
            .await
            .expect("usage event");
        assert_eq!(
            store
                .get_session(session.id)
                .await
                .expect("materialized session")
                .context_usage,
            Some(usage)
        );
    }

    #[tokio::test]
    async fn event_and_message_pages_use_stable_server_cursors() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("pages").await.expect("session");
        for index in 0..5 {
            store
                .append_event(
                    session.id,
                    None,
                    "agent.message_end",
                    json!({"message":{"role":if index % 2 == 0 {"user"} else {"assistant"},"content":[{"type":"text","text":index.to_string()}]}}),
                )
                .await
                .expect("message event");
        }
        let first = store
            .list_event_page(session.id, 0, 2)
            .await
            .expect("event page");
        assert!(first.has_more);
        let second = store
            .list_event_page(
                session.id,
                first
                    .next_cursor
                    .as_deref()
                    .expect("event cursor")
                    .parse()
                    .expect("seq"),
                2,
            )
            .await
            .expect("second event page");
        assert_eq!(second.items[0].seq, first.items[1].seq + 1);

        let newest = store
            .list_message_event_page(session.id, None, 2)
            .await
            .expect("message page");
        assert!(newest.has_more);
        assert_eq!(newest.items.len(), 2);
        let older = store
            .list_message_event_page(session.id, newest.next_cursor.as_deref(), 2)
            .await
            .expect("older messages");
        assert!(older.items.last().expect("older item").seq < newest.items[0].seq);
    }

    #[tokio::test]
    async fn message_pages_include_durable_sticker_parts_between_messages() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("stickers").await.expect("session");
        let turn = TurnId::new();
        store
            .append_event(
                session.id,
                Some(turn),
                "agent.message_end",
                json!({"message":{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"send_character_sticker","arguments":{}}]}}),
            )
            .await
            .expect("tool message");
        store
            .append_event(
                session.id,
                Some(turn),
                "character.sticker.sent",
                json!({"part":{"type":"sticker","stickerId":1,"characterId":7,"name":"开心","url":"/media/happy.webp"}}),
            )
            .await
            .expect("sticker");
        store
            .append_event(
                session.id,
                Some(turn),
                "agent.message_end",
                json!({"message":{"role":"assistant","content":[{"type":"text","text":"完成"}]}}),
            )
            .await
            .expect("final message");

        let page = store
            .list_message_event_page(session.id, None, 10)
            .await
            .expect("message page");
        assert_eq!(
            page.items
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec![
                "agent.message_end",
                "character.sticker.sent",
                "agent.message_end"
            ]
        );
        assert!(!page.has_more);
    }

    #[tokio::test]
    async fn rejecting_a_question_is_distinct_from_answering_with_an_empty_array() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("questions").await.expect("session");
        let request_id = QuestionRequestId::new();
        store
            .create_question(
                request_id,
                session.id,
                TurnId::new(),
                json!([{"header":"确认","question":"继续吗？","options":[{"label":"是","description":"继续"},{"label":"否","description":"停止"}]}]),
            )
            .await
            .expect("question");
        let mutation = store
            .reject_question(request_id)
            .await
            .expect("reject question");
        assert_eq!(mutation.question.state, QuestionState::Rejected);
        assert!(mutation.question.answers.is_none());
        assert_eq!(mutation.event.payload["state"], "rejected");
        assert!(
            store
                .list_pending_questions(Some(session.id))
                .await
                .expect("pending questions")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn runtime_metrics_are_transactional_monotonic_and_survive_session_deletion() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("metrics").await.expect("session");
        let turn_id = TurnId::new();
        store
            .append_event(session.id, Some(turn_id), "turn.started", json!({}))
            .await
            .expect("turn start");
        store
            .append_event(
                session.id,
                Some(turn_id),
                "agent.message_update",
                json!({"message":{"role":"assistant"},"delta":"a"}),
            )
            .await
            .expect("first token");
        store
            .append_event(
                session.id,
                Some(turn_id),
                "agent.message_update",
                json!({"message":{"role":"assistant"},"delta":"b"}),
            )
            .await
            .expect("later token");
        store
            .append_event(
                session.id,
                Some(turn_id),
                "agent.model_retry",
                json!({"attempt":2}),
            )
            .await
            .expect("provider retry");
        store
            .append_event(
                session.id,
                Some(turn_id),
                "agent.tool_execution_start",
                json!({"toolCallId":"call-1","toolName":"read_file"}),
            )
            .await
            .expect("tool start");
        store
            .append_event(
                session.id,
                Some(turn_id),
                "agent.tool_execution_end",
                json!({"toolCallId":"call-1","toolName":"read_file","isError":true}),
            )
            .await
            .expect("tool end");
        store
            .append_event(session.id, Some(turn_id), "turn.completed", json!({}))
            .await
            .expect("turn complete");

        let before_delete = store
            .runtime_metrics_snapshot()
            .await
            .expect("metrics before deletion");
        assert_eq!(before_delete.active_sessions, 1);
        assert_eq!(before_delete.turns_started, 1);
        assert_eq!(before_delete.turns_completed, 1);
        assert_eq!(before_delete.turns_failed, 0);
        assert_eq!(before_delete.provider_retries, 1);
        assert_eq!(before_delete.tool_calls_started, 1);
        assert_eq!(before_delete.tool_calls_completed, 1);
        assert_eq!(before_delete.tool_calls_failed, 1);
        assert_eq!(before_delete.first_token_samples, 1);
        assert_eq!(before_delete.turn_duration_samples, 1);
        assert_eq!(before_delete.tool_duration_samples, 1);

        assert!(
            store
                .begin_session_deletion(session.id)
                .await
                .expect("begin deletion")
        );
        assert!(store.delete_session(session.id).await.expect("delete"));
        let after_delete = store
            .runtime_metrics_snapshot()
            .await
            .expect("metrics after deletion");
        assert_eq!(after_delete.active_sessions, 0);
        assert_eq!(after_delete.turns_started, before_delete.turns_started);
        assert_eq!(after_delete.turns_completed, before_delete.turns_completed);
        assert_eq!(
            after_delete.first_token_samples,
            before_delete.first_token_samples
        );
        assert_eq!(
            after_delete.tool_calls_failed,
            before_delete.tool_calls_failed
        );
    }

    #[tokio::test]
    async fn database_runtime_binding_prunes_foreign_sessions_and_fails_closed() {
        let store = Store::in_memory().await.expect("store");
        let mon = store
            .create_session_with_runtime_origin(
                "mon",
                Vec::new(),
                json!({}),
                SessionRuntimeOrigin::Mon,
            )
            .await
            .expect("mon session");
        let local = store
            .create_session_with_runtime_origin(
                "local",
                Vec::new(),
                json!({}),
                SessionRuntimeOrigin::Local,
            )
            .await
            .expect("local session");

        assert_eq!(
            store
                .bind_runtime_origin(SessionRuntimeOrigin::Local, false)
                .await
                .expect("bind local"),
            1
        );
        assert!(store.get_session(local.id).await.is_ok());
        assert!(matches!(
            store.get_session(mon.id).await,
            Err(StoreError::SessionNotFound(_))
        ));
        assert_eq!(
            store
                .bind_runtime_origin(SessionRuntimeOrigin::Local, false)
                .await
                .expect("idempotent bind"),
            0
        );
        assert!(matches!(
            store
                .bind_runtime_origin(SessionRuntimeOrigin::Mon, false)
                .await,
            Err(StoreError::InvalidValue(_))
        ));

        assert_eq!(
            store
                .bind_runtime_origin(SessionRuntimeOrigin::Mon, true)
                .await
                .expect("one-shot migration rebind"),
            1
        );
        assert!(store.get_session(local.id).await.is_err());
    }

    #[tokio::test]
    async fn voice_speech_segments_are_upserted_filtered_and_deleted_with_the_session() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("voice").await.expect("session");
        let first_blob = store
            .put_blob_metadata("voice-1", "audio/wav", 4, "aa/voice-1")
            .await
            .expect("first blob");
        let second_blob = store
            .put_blob_metadata("voice-2", "audio/wav", 8, "bb/voice-2")
            .await
            .expect("second blob");
        let base = VoiceSpeechSegmentUpsert {
            session_id: session.id,
            external_message_id: "message-1".to_owned(),
            external_audio_asset_id: None,
            audio_blob_id: first_blob.id,
            duration_ms: Some(1200),
            audio_format: "wav".to_owned(),
            segment_group_id: "message-1:0:0".to_owned(),
            group_index: 0,
            sequence: 0,
            text_hash: "hash-1".to_owned(),
            text_length: 4,
        };
        let inserted = store
            .upsert_voice_speech_segment(base.clone())
            .await
            .expect("insert segment");
        for sequence in 1..=2 {
            store
                .upsert_voice_speech_segment(VoiceSpeechSegmentUpsert {
                    sequence,
                    text_hash: format!("old-hash-{sequence}"),
                    ..base.clone()
                })
                .await
                .expect("insert old trailing segment");
        }
        let updated = store
            .upsert_voice_speech_segment(VoiceSpeechSegmentUpsert {
                audio_blob_id: second_blob.id,
                duration_ms: Some(2400),
                text_hash: "hash-2".to_owned(),
                ..base
            })
            .await
            .expect("update segment");
        assert_eq!(updated.id, inserted.id);
        assert_eq!(updated.audio_blob_id, second_blob.id);
        assert_eq!(updated.text_hash, "hash-2");

        let listed = store
            .list_voice_speech_segments(session.id, Some("message-1"))
            .await
            .expect("list segment");
        // A successful new sequence zero replaces the previous rendering and
        // therefore removes any trailing segments from its old chunk plan.
        assert_eq!(listed, vec![updated]);
        assert!(
            store
                .list_voice_speech_segments(session.id, Some("missing"))
                .await
                .expect("filter segments")
                .is_empty()
        );

        assert!(
            store
                .delete_session(session.id)
                .await
                .expect("delete session")
        );
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_speech_segments")
            .fetch_one(&store.pool)
            .await
            .expect("count segments");
        assert_eq!(remaining, 0);
    }
}
