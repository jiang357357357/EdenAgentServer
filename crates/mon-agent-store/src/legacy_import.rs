use crate::{Store, StoreError, now_ms};
use serde_json::{Map, Value, json};
use sqlx::{
    Row, Sqlite, Transaction,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::path::Path;
use uuid::Uuid;

const SOURCE_KIND: &str = "moncore-agent-session-v1";
const DOMAIN_SOURCE_KIND: &str = "moncore-agent-domain-v1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LegacyImportReport {
    pub sessions_imported: u64,
    pub messages_imported: u64,
    pub sessions_skipped: u64,
    pub memories_imported: u64,
    pub work_memories_imported: u64,
    pub memos_imported: u64,
    pub self_awake_runs_imported: u64,
    pub self_awake_diaries_imported: u64,
    pub director_runs_imported: u64,
    pub connectors_imported: u64,
    pub connector_events_imported: u64,
    pub skills_recorded: u64,
    pub character_states_imported: u64,
    pub permission_modes_imported: u64,
    pub domain_items_skipped: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LegacyMigrationAudit {
    pub imported_sessions: i64,
    pub imported_domain_items: i64,
    pub skills_requiring_reinstall: i64,
    pub connectors_requiring_reconnect: i64,
    pub quarantined_work_items: i64,
    pub permission_reauthorization_required: bool,
}

#[derive(Debug)]
struct LegacySession {
    id: i64,
    user_id: i64,
    source: String,
    external_session_id: String,
    title: String,
    status: String,
    session_payload: Option<String>,
    session_events_payload: Option<String>,
    director_policy: Option<String>,
    mode: Option<String>,
    assistant_id: Option<i64>,
    character_id: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug)]
struct LegacyMessage {
    id: i64,
    external_message_id: String,
    kind: String,
    message_payload: Option<String>,
    created_at: i64,
}

impl Store {
    /// Imports the former Django/MonCore Agent projection into the native Rust store.
    ///
    /// The source database is opened read-only. Every legacy session is imported in one
    /// target transaction and recorded in `legacy_session_imports`, making startup retries
    /// safe and idempotent.
    pub async fn import_legacy_moncore_sessions(
        &self,
        source_database: &Path,
    ) -> Result<LegacyImportReport, StoreError> {
        let source = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(source_database)
                    .read_only(true)
                    .create_if_missing(false),
            )
            .await?;

        let has_legacy_schema: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='Agent_session_map'",
        )
        .fetch_one(&source)
        .await?;
        if has_legacy_schema == 0 {
            source.close().await;
            return Ok(LegacyImportReport::default());
        }

        let rows = sqlx::query(
            "SELECT id, user_id, source, external_session_id, title, status, session_payload,
                    session_events_payload, director_policy, mode,
                    assistant_id, character_id,
                    COALESCE(CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER), 0) AS created_at_ms,
                    COALESCE(CAST((julianday(updated_at) - 2440587.5) * 86400000 AS INTEGER), 0) AS updated_at_ms
             FROM Agent_session_map
             ORDER BY created_at, id",
        )
        .fetch_all(&source)
        .await?;

        let mut report = LegacyImportReport::default();
        for row in rows {
            let legacy = LegacySession {
                id: row.try_get("id")?,
                user_id: row.try_get("user_id")?,
                source: row.try_get("source")?,
                external_session_id: row.try_get("external_session_id")?,
                title: row.try_get("title")?,
                status: row.try_get("status")?,
                session_payload: row.try_get("session_payload")?,
                session_events_payload: row.try_get("session_events_payload")?,
                director_policy: row.try_get("director_policy")?,
                mode: row.try_get("mode")?,
                assistant_id: row.try_get("assistant_id")?,
                character_id: row.try_get("character_id")?,
                created_at: row.try_get("created_at_ms")?,
                updated_at: row.try_get("updated_at_ms")?,
            };
            let legacy_key = format!(
                "{}:{}:{}:{}",
                legacy.user_id, legacy.source, legacy.external_session_id, legacy.id
            );
            let already_imported: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM legacy_session_imports WHERE source_kind=? AND legacy_session_key=?",
            )
            .bind(SOURCE_KIND)
            .bind(&legacy_key)
            .fetch_one(&self.pool)
            .await?;
            if already_imported > 0 {
                report.sessions_skipped += 1;
                continue;
            }

            let messages = load_legacy_messages(&source, legacy.id).await?;
            let (messages_imported, character_states_imported) = self
                .import_one_legacy_session(&legacy, &legacy_key, &messages)
                .await?;
            report.sessions_imported += 1;
            report.messages_imported += messages_imported;
            report.character_states_imported += character_states_imported;
        }
        source.close().await;
        Ok(report)
    }

    async fn import_one_legacy_session(
        &self,
        legacy: &LegacySession,
        legacy_key: &str,
        messages: &[LegacyMessage],
    ) -> Result<(u64, u64), StoreError> {
        let target_session_id = Uuid::new_v4().to_string();
        let participants = legacy_participants(legacy);
        let session_payload = legacy
            .session_payload
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        let created_at = positive_time(legacy.created_at);
        let updated_at = positive_time(legacy.updated_at).max(created_at);
        let status = if legacy.status == "archived" || legacy.status == "closed" {
            "closed"
        } else {
            "active"
        };
        let title = if legacy.title.trim().is_empty() {
            "历史会话"
        } else {
            legacy.title.trim()
        };

        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO sessions(
                id, title, title_source, status, next_seq, participants_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
        )
        .bind(&target_session_id)
        .bind(title)
        .bind(legacy_title_source(session_payload.as_ref()))
        .bind(status)
        .bind(serde_json::to_string(&participants)?)
        .bind(created_at)
        .bind(updated_at)
        .execute(&mut *transaction)
        .await?;

        let mut next_seq = 1_i64;
        let mut current_turn: Option<String> = None;
        let mut current_turn_has_messages = false;
        for legacy_message in messages {
            let mut api_message = legacy_message
                .message_payload
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or_else(|| json!({"info":{"id":legacy_message.external_message_id,"role":legacy_message.kind},"parts":[]}));
            rewrite_legacy_session_id(&mut api_message, &target_session_id);
            let role = api_message
                .pointer("/info/role")
                .and_then(Value::as_str)
                .unwrap_or(&legacy_message.kind);

            if role == "user" && current_turn_has_messages {
                append_imported_event(
                    &mut transaction,
                    &target_session_id,
                    &mut next_seq,
                    current_turn.as_deref(),
                    "turn.completed",
                    json!({"imported":true}),
                    legacy_message.created_at,
                )
                .await?;
                current_turn = None;
            }
            if current_turn.is_none() {
                current_turn = Some(Uuid::new_v4().to_string());
            }

            let runtime_message = runtime_message(&api_message, role, legacy_message.created_at);
            let mut payload = Map::new();
            payload.insert(
                "legacy".to_owned(),
                json!({
                    "source": SOURCE_KIND,
                    "sessionId": legacy.external_session_id,
                    "messageId": legacy_message.external_message_id,
                    "rowId": legacy_message.id,
                    "originalMessage": api_message,
                }),
            );
            if let Some(message) = runtime_message {
                payload.insert("message".to_owned(), message);
            }
            append_imported_event(
                &mut transaction,
                &target_session_id,
                &mut next_seq,
                current_turn.as_deref(),
                "agent.message_end",
                Value::Object(payload),
                legacy_message.created_at,
            )
            .await?;
            current_turn_has_messages = true;
        }
        if current_turn_has_messages {
            append_imported_event(
                &mut transaction,
                &target_session_id,
                &mut next_seq,
                current_turn.as_deref(),
                "turn.completed",
                json!({"imported":true}),
                updated_at,
            )
            .await?;
        }

        let context_snapshots = legacy_context_snapshots(legacy);
        for (payload, created_at) in context_snapshots {
            append_imported_event(
                &mut transaction,
                &target_session_id,
                &mut next_seq,
                None,
                "context.skill_snapshot",
                payload,
                created_at,
            )
            .await?;
        }
        let character_states =
            legacy_character_states(session_payload.as_ref(), &target_session_id);
        for payload in &character_states {
            append_imported_event(
                &mut transaction,
                &target_session_id,
                &mut next_seq,
                None,
                "character.action.changed",
                payload.clone(),
                updated_at,
            )
            .await?;
        }
        append_imported_event(
            &mut transaction,
            &target_session_id,
            &mut next_seq,
            None,
            "legacy.session_state",
            json!({
                "source":SOURCE_KIND,
                "legacySessionId":legacy.external_session_id,
                "mode":legacy.mode,
                "directorPolicy":parse_json(legacy.director_policy.as_deref()),
                "orchestratorRuns":session_payload
                    .as_ref()
                    .and_then(|value|value.get("orchestratorRuns"))
                    .cloned()
                    .unwrap_or_else(||json!([])),
            }),
            updated_at,
        )
        .await?;

        sqlx::query("UPDATE sessions SET next_seq=?, updated_at=? WHERE id=?")
            .bind(next_seq)
            .bind(updated_at)
            .bind(&target_session_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "INSERT INTO legacy_session_imports(
                source_kind, legacy_session_key, target_session_id, legacy_user_id,
                imported_message_count, imported_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(SOURCE_KIND)
        .bind(legacy_key)
        .bind(&target_session_id)
        .bind(legacy.user_id)
        .bind(i64::try_from(messages.len()).unwrap_or(i64::MAX))
        .bind(now_ms())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok((
            messages.len().try_into().unwrap_or(u64::MAX),
            character_states.len().try_into().unwrap_or(u64::MAX),
        ))
    }
}

impl Store {
    /// Imports all durable MonCore-owned Agent data that can be represented by the
    /// native Rust store. Elevated permissions, connector credentials, pending
    /// connector events, pending self-awake work, and skill packages are never
    /// activated implicitly during migration.
    pub async fn import_legacy_moncore_data(
        &self,
        source_database: &Path,
    ) -> Result<LegacyImportReport, StoreError> {
        let mut report = self.import_legacy_moncore_sessions(source_database).await?;
        let source = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(source_database)
                    .read_only(true)
                    .create_if_missing(false),
            )
            .await?;
        import_memories(self, &source, &mut report).await?;
        import_work_memories(self, &source, &mut report).await?;
        import_memos(self, &source, &mut report).await?;
        import_permission_mode(self, &source, &mut report).await?;
        import_self_awake(self, &source, &mut report).await?;
        import_director_runs(self, &source, &mut report).await?;
        import_connectors(self, &source, &mut report).await?;
        import_skill_installations(self, &source, &mut report).await?;
        source.close().await;
        Ok(report)
    }

    /// Returns durable evidence about the one-time MonCore import and any items
    /// deliberately left inactive for explicit operator review.
    pub async fn legacy_migration_audit(&self) -> Result<LegacyMigrationAudit, StoreError> {
        let row = sqlx::query(
            "SELECT
                (SELECT COUNT(*) FROM legacy_session_imports) AS imported_sessions,
                (SELECT COUNT(*) FROM legacy_import_items WHERE source_kind=?) AS imported_domain_items,
                (SELECT COUNT(*) FROM legacy_skill_installations
                 WHERE migration_state='requires_reinstall') AS skills_requiring_reinstall,
                (SELECT COUNT(*)
                 FROM legacy_import_items item
                 JOIN connectors connector ON connector.id=item.target_key
                 WHERE item.source_kind=? AND item.entity_kind='connector'
                   AND connector.desired_state='disconnected') AS connectors_requiring_reconnect,
                (SELECT COUNT(*) FROM legacy_import_items
                 WHERE source_kind=?
                   AND entity_kind IN ('self_awake_run', 'connector_event')) AS quarantined_work_items",
        )
        .bind(DOMAIN_SOURCE_KIND)
        .bind(DOMAIN_SOURCE_KIND)
        .bind(DOMAIN_SOURCE_KIND)
        .fetch_one(&self.pool)
        .await?;
        let permission = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM app_config WHERE key='legacy.permission.mode'",
        )
        .fetch_optional(&self.pool)
        .await?
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("requiresExplicitReauthorization")
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);
        Ok(LegacyMigrationAudit {
            imported_sessions: row.try_get("imported_sessions")?,
            imported_domain_items: row.try_get("imported_domain_items")?,
            skills_requiring_reinstall: row.try_get("skills_requiring_reinstall")?,
            connectors_requiring_reconnect: row.try_get("connectors_requiring_reconnect")?,
            quarantined_work_items: row.try_get("quarantined_work_items")?,
            permission_reauthorization_required: permission,
        })
    }
}

async fn source_has_table(source: &sqlx::SqlitePool, table: &str) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
    )
    .bind(table)
    .fetch_one(source)
    .await?
        > 0)
}

async fn legacy_item_exists(
    store: &Store,
    entity_kind: &str,
    legacy_key: &str,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM legacy_import_items
         WHERE source_kind=? AND entity_kind=? AND legacy_key=?",
    )
    .bind(DOMAIN_SOURCE_KIND)
    .bind(entity_kind)
    .bind(legacy_key)
    .fetch_one(&store.pool)
    .await?
        > 0)
}

async fn record_legacy_item(
    transaction: &mut Transaction<'_, Sqlite>,
    entity_kind: &str,
    legacy_key: &str,
    target_key: &str,
    details: Value,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO legacy_import_items(
            source_kind, entity_kind, legacy_key, target_key, details_json, imported_at
         ) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(DOMAIN_SOURCE_KIND)
    .bind(entity_kind)
    .bind(legacy_key)
    .bind(target_key)
    .bind(serde_json::to_string(&details)?)
    .bind(now_i64())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn import_memories(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_memory").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, scope_key, kind, content, source_session_id, source_message_ids,
                confidence, sensitivity, metadata, assistant_id, user_id, agent_character_id,
                scope_type,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_memory ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "memory", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let content: String = row.try_get("content")?;
        let character_id: Option<i64> = row.try_get("agent_character_id")?;
        let source_scope_type: String = row.try_get("scope_type")?;
        let source_scope_key: String = row.try_get("scope_key")?;
        let (scope_type, scope_key) = if let Some(character_id) = character_id {
            ("agent_character".to_owned(), character_id.to_string())
        } else {
            (source_scope_type, source_scope_key)
        };
        let metadata = json!({
            "legacy":{
                "source":DOMAIN_SOURCE_KIND,
                "id":legacy_id,
                "assistantId":row.try_get::<Option<i64>,_>("assistant_id")?,
                "userId":row.try_get::<i64,_>("user_id")?,
                "sourceMessageIds":parse_json(row.try_get::<Option<String>,_>("source_message_ids")?.as_deref()),
                "confidence":row.try_get::<f64,_>("confidence")?,
                "sensitivity":row.try_get::<String,_>("sensitivity")?,
                "metadata":parse_json(row.try_get::<Option<String>,_>("metadata")?.as_deref()),
            }
        });
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let target_id: i64 = sqlx::query_scalar(
            "INSERT INTO memories(
                content, kind, scope_type, scope_key, source_session_id,
                metadata_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(content)
        .bind(row.try_get::<String, _>("kind")?)
        .bind(scope_type)
        .bind(scope_key)
        .bind(row.try_get::<String, _>("source_session_id")?)
        .bind(serde_json::to_string(&metadata)?)
        .bind(positive_time(row.try_get("created_at_ms")?))
        .bind(positive_time(row.try_get("updated_at_ms")?))
        .fetch_one(&mut *transaction)
        .await?;
        record_legacy_item(
            &mut transaction,
            "memory",
            &legacy_key,
            &target_id.to_string(),
            json!({"state":"imported"}),
        )
        .await?;
        transaction.commit().await?;
        report.memories_imported += 1;
    }
    Ok(())
}

async fn import_work_memories(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_work_memory").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, scope, summary, open_threads, avoid_repeating, source,
                assistant_id, character_id, user_id,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_work_memory ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "work_memory", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let summary: String = row.try_get("summary")?;
        let open_threads = row
            .try_get::<Option<String>, _>("open_threads")?
            .unwrap_or_default();
        let avoid_repeating = row
            .try_get::<Option<String>, _>("avoid_repeating")?
            .unwrap_or_default();
        let content = [
            (!summary.trim().is_empty()).then(|| summary.trim().to_owned()),
            (!open_threads.trim().is_empty())
                .then(|| format!("Open threads:\n{}", open_threads.trim())),
            (!avoid_repeating.trim().is_empty())
                .then(|| format!("Avoid repeating:\n{}", avoid_repeating.trim())),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n");
        let character_id: Option<i64> = row.try_get("character_id")?;
        let assistant_id: Option<i64> = row.try_get("assistant_id")?;
        let user_id: i64 = row.try_get("user_id")?;
        let (scope_type, scope_key) = if let Some(character_id) = character_id {
            ("agent_character", character_id.to_string())
        } else if let Some(assistant_id) = assistant_id {
            ("agent_assistant", assistant_id.to_string())
        } else {
            ("user", user_id.to_string())
        };
        let metadata = json!({"legacy":{
            "source":DOMAIN_SOURCE_KIND,
            "id":legacy_id,
            "scope":row.try_get::<String,_>("scope")?,
            "sourceName":row.try_get::<String,_>("source")?,
            "assistantId":assistant_id,
            "characterId":character_id,
            "userId":user_id,
        }});
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let target_id: i64 = sqlx::query_scalar(
            "INSERT INTO memories(
                content, kind, scope_type, scope_key, source_session_id,
                metadata_json, created_at, updated_at
             ) VALUES (?, 'work_memory', ?, ?, '', ?, ?, ?) RETURNING id",
        )
        .bind(content)
        .bind(scope_type)
        .bind(scope_key)
        .bind(serde_json::to_string(&metadata)?)
        .bind(positive_time(row.try_get("created_at_ms")?))
        .bind(positive_time(row.try_get("updated_at_ms")?))
        .fetch_one(&mut *transaction)
        .await?;
        record_legacy_item(
            &mut transaction,
            "work_memory",
            &legacy_key,
            &target_id.to_string(),
            json!({"state":"imported"}),
        )
        .await?;
        transaction.commit().await?;
        report.work_memories_imported += 1;
    }
    Ok(())
}

async fn import_memos(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "user_memo").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, title, content, kind, status, priority, remind_at, due_at, repeat_rule,
                source, related_session_id, related_message_id, semantic_task_id,
                last_triggered_at, snoozed_until, completed_at, metadata, user_id,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms,
                CAST((julianday(remind_at)-2440587.5)*86400000 AS INTEGER) AS remind_at_ms,
                CAST((julianday(due_at)-2440587.5)*86400000 AS INTEGER) AS due_at_ms,
                CAST((julianday(last_triggered_at)-2440587.5)*86400000 AS INTEGER) AS last_triggered_at_ms,
                CAST((julianday(snoozed_until)-2440587.5)*86400000 AS INTEGER) AS snoozed_until_ms,
                CAST((julianday(completed_at)-2440587.5)*86400000 AS INTEGER) AS completed_at_ms
         FROM user_memo ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "memo", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let raw_kind: String = row.try_get("kind")?;
        let remind_at: Option<i64> = row.try_get("remind_at_ms")?;
        let due_at: Option<i64> = row.try_get("due_at_ms")?;
        let kind = match raw_kind.as_str() {
            "note" | "reminder" | "todo" => raw_kind,
            _ if remind_at.is_some() || due_at.is_some() => "reminder".to_owned(),
            _ => "note".to_owned(),
        };
        let raw_status: String = row.try_get("status")?;
        let status = match raw_status.as_str() {
            "active" | "done" | "archived" | "cancelled" => raw_status,
            "completed" => "done".to_owned(),
            _ => "active".to_owned(),
        };
        let raw_priority: String = row.try_get("priority")?;
        let priority = match raw_priority.as_str() {
            "low" | "normal" | "high" => raw_priority,
            _ => "normal".to_owned(),
        };
        let metadata = json!({
            "legacy":{
                "source":DOMAIN_SOURCE_KIND,
                "id":legacy_id,
                "userId":row.try_get::<i64,_>("user_id")?,
                "relatedMessageId":row.try_get::<String,_>("related_message_id")?,
                "semanticTaskId":row.try_get::<String,_>("semantic_task_id")?,
                "metadata":parse_json(row.try_get::<Option<String>,_>("metadata")?.as_deref()),
            }
        });
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let target_id: i64 = sqlx::query_scalar(
            "INSERT INTO memos(
                title, content, kind, status, priority, remind_at, due_at, repeat_rule,
                source, related_session_id, last_triggered_at, snoozed_until, completed_at,
                metadata_json, created_at, updated_at, operation_key
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(row.try_get::<String, _>("title")?)
        .bind(row.try_get::<String, _>("content")?)
        .bind(kind)
        .bind(status)
        .bind(priority)
        .bind(remind_at)
        .bind(due_at)
        .bind(row.try_get::<String, _>("repeat_rule")?)
        .bind(row.try_get::<String, _>("source")?)
        .bind(row.try_get::<String, _>("related_session_id")?)
        .bind(row.try_get::<Option<i64>, _>("last_triggered_at_ms")?)
        .bind(row.try_get::<Option<i64>, _>("snoozed_until_ms")?)
        .bind(row.try_get::<Option<i64>, _>("completed_at_ms")?)
        .bind(serde_json::to_string(&metadata)?)
        .bind(positive_time(row.try_get("created_at_ms")?))
        .bind(positive_time(row.try_get("updated_at_ms")?))
        .bind(format!("legacy:moncore:memo:{legacy_id}"))
        .fetch_one(&mut *transaction)
        .await?;
        record_legacy_item(
            &mut transaction,
            "memo",
            &legacy_key,
            &target_id.to_string(),
            json!({"state":"imported"}),
        )
        .await?;
        transaction.commit().await?;
        report.memos_imported += 1;
    }
    Ok(())
}

async fn import_permission_mode(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "user_agent_settings").await? {
        return Ok(());
    }
    let row = sqlx::query(
        "SELECT id, user_id, permission_mode,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM user_agent_settings WHERE enabled=1 ORDER BY updated_at DESC, id DESC LIMIT 1",
    )
    .fetch_optional(source)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let legacy_id: i64 = row.try_get("id")?;
    let legacy_key = legacy_id.to_string();
    if legacy_item_exists(store, "permission_mode", &legacy_key).await? {
        report.domain_items_skipped += 1;
        return Ok(());
    }
    let mode: String = row.try_get("permission_mode")?;
    let safe_mode = match mode.as_str() {
        "restricted" => "restricted",
        _ => "restricted",
    };
    let value = json!({
        "mode":mode,
        "safeEffectiveMode":safe_mode,
        "requiresExplicitReauthorization":mode != safe_mode,
        "legacyUserId":row.try_get::<i64,_>("user_id")?,
        "updatedAt":positive_time(row.try_get("updated_at_ms")?),
    });
    let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "INSERT INTO app_config(key, value_json, updated_at) VALUES ('legacy.permission.mode', ?, ?)
         ON CONFLICT(key) DO NOTHING",
    )
    .bind(serde_json::to_string(&value)?)
    .bind(now_i64())
    .execute(&mut *transaction)
    .await?;
    record_legacy_item(
        &mut transaction,
        "permission_mode",
        &legacy_key,
        "legacy.permission.mode",
        json!({"state":"recorded","activated":false}),
    )
    .await?;
    transaction.commit().await?;
    report.permission_modes_imported += 1;
    Ok(())
}

async fn target_session_for_legacy(
    store: &Store,
    source: &sqlx::SqlitePool,
    legacy_session_id: i64,
) -> Result<Option<String>, StoreError> {
    let row = sqlx::query(
        "SELECT id, user_id, source, external_session_id FROM Agent_session_map WHERE id=?",
    )
    .bind(legacy_session_id)
    .fetch_optional(source)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let legacy_key = format!(
        "{}:{}:{}:{}",
        row.try_get::<i64, _>("user_id")?,
        row.try_get::<String, _>("source")?,
        row.try_get::<String, _>("external_session_id")?,
        row.try_get::<i64, _>("id")?,
    );
    sqlx::query_scalar::<_, String>(
        "SELECT target_session_id FROM legacy_session_imports
         WHERE source_kind=? AND legacy_session_key=?",
    )
    .bind(SOURCE_KIND)
    .bind(legacy_key)
    .fetch_optional(&store.pool)
    .await
    .map_err(StoreError::from)
}

async fn target_session_for_user(store: &Store, user_id: i64) -> Result<String, StoreError> {
    if let Some(session_id) = sqlx::query_scalar::<_, String>(
        "SELECT target_session_id FROM legacy_session_imports
         WHERE source_kind=? AND legacy_user_id=? ORDER BY imported_at DESC LIMIT 1",
    )
    .bind(SOURCE_KIND)
    .bind(user_id)
    .fetch_optional(&store.pool)
    .await?
    {
        return Ok(session_id);
    }
    let legacy_key = format!("user:{user_id}:background");
    if let Some(session_id) = sqlx::query_scalar::<_, String>(
        "SELECT item.target_key
         FROM legacy_import_items item
         JOIN sessions session ON session.id=item.target_key
         WHERE item.source_kind=?
           AND item.entity_kind='background_session'
           AND item.legacy_key=?",
    )
    .bind(DOMAIN_SOURCE_KIND)
    .bind(&legacy_key)
    .fetch_optional(&store.pool)
    .await?
    {
        return Ok(session_id);
    }
    let session_id = Uuid::new_v4().to_string();
    let now = now_i64();
    let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "INSERT INTO sessions(
            id, title, title_source, status, next_seq, participants_json, created_at, updated_at
         ) VALUES (?, '历史后台状态', 'legacy', 'closed', 1, '[]', ?, ?)",
    )
    .bind(&session_id)
    .bind(now)
    .bind(now)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "DELETE FROM legacy_import_items
         WHERE source_kind=? AND entity_kind='background_session' AND legacy_key=?",
    )
    .bind(DOMAIN_SOURCE_KIND)
    .bind(&legacy_key)
    .execute(&mut *transaction)
    .await?;
    record_legacy_item(
        &mut transaction,
        "background_session",
        &legacy_key,
        &session_id,
        json!({"state":"created","legacyUserId":user_id}),
    )
    .await?;
    transaction.commit().await?;
    Ok(session_id)
}

async fn import_self_awake(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_self_awake_run").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, source_service, external_run_id, status, context_payload, decision_payload,
                mood, current_desire, should_interrupt_user, next_wake_after_minutes,
                next_wake_reason, error, assistant_id, character_id, user_id,
                event_type, event_source, event_reason, event_id,
                CAST((julianday(started_at)-2440587.5)*86400000 AS INTEGER) AS started_at_ms,
                CAST((julianday(finished_at)-2440587.5)*86400000 AS INTEGER) AS finished_at_ms,
                CAST((julianday(next_wake_at)-2440587.5)*86400000 AS INTEGER) AS next_wake_at_ms,
                CAST((julianday(event_occurred_at)-2440587.5)*86400000 AS INTEGER) AS event_occurred_at_ms,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_self_awake_run ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "self_awake_run", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let user_id: i64 = row.try_get("user_id")?;
        let session_id = target_session_for_user(store, user_id).await?;
        let target_run_id = Uuid::new_v4().to_string();
        let target_job_id = Uuid::new_v4().to_string();
        let external_run_id: String = row.try_get("external_run_id")?;
        let source_status: String = row.try_get("status")?;
        let completed = matches!(source_status.as_str(), "succeeded" | "completed");
        let target_status = if completed { "completed" } else { "failed" };
        let created_at = positive_time(row.try_get("created_at_ms")?);
        let updated_at = positive_time(row.try_get("updated_at_ms")?).max(created_at);
        let started_at: Option<i64> = row.try_get("started_at_ms")?;
        let finished_at: Option<i64> = row.try_get("finished_at_ms")?;
        let mood: String = row.try_get("mood")?;
        let current_desire: String = row.try_get("current_desire")?;
        let source_service: String = row.try_get("source_service")?;
        let actions = legacy_self_awake_actions(source, legacy_id).await?;
        let request = json!({
            "schemaVersion":"legacy.moncore.v1",
            "legacyRunId":external_run_id,
            "trigger":{
                "type":row.try_get::<Option<String>,_>("event_type")?,
                "source":row.try_get::<Option<String>,_>("event_source")?,
                "reason":row.try_get::<Option<String>,_>("event_reason")?,
                "eventId":row.try_get::<Option<String>,_>("event_id")?,
                "occurredAt":row.try_get::<Option<i64>,_>("event_occurred_at_ms")?,
            },
            "context":redact_legacy_secrets(parse_json(
                row.try_get::<Option<String>,_>("context_payload")?.as_deref()
            )),
            "nextWake":{
                "at":row.try_get::<Option<i64>,_>("next_wake_at_ms")?,
                "afterMinutes":row.try_get::<Option<i64>,_>("next_wake_after_minutes")?,
                "reason":row.try_get::<Option<String>,_>("next_wake_reason")?,
            },
        });
        let decision = json!({
            "legacyDecision":redact_legacy_secrets(parse_json(
                row.try_get::<Option<String>,_>("decision_payload")?.as_deref()
            )),
            "mood":mood,
            "currentDesire":current_desire,
            "shouldInterruptUser":row.try_get::<bool,_>("should_interrupt_user")?,
            "actions":actions,
        });
        let author = json!({
            "assistantId":row.try_get::<Option<i64>,_>("assistant_id")?,
            "characterId":row.try_get::<Option<i64>,_>("character_id")?,
            "legacyUserId":user_id,
            "sourceService":source_service,
        });
        let source_error: Option<String> = row.try_get("error")?;
        let last_error = if completed {
            source_error
        } else if matches!(source_status.as_str(), "pending" | "running") {
            Some("legacy pending work was imported as failed and was not replayed".to_owned())
        } else {
            source_error.or_else(|| Some(format!("legacy status: {source_status}")))
        };
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO jobs(
                id, kind, session_id, due_at, payload_json, state, attempts,
                idempotency_key, last_error, created_at, updated_at
             ) VALUES (?, 'self_awake', ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        )
        .bind(&target_job_id)
        .bind(&session_id)
        .bind(updated_at)
        .bind(serde_json::to_string(&json!({"legacyImport":request}))?)
        .bind(if completed { "completed" } else { "failed" })
        .bind(format!("legacy:moncore:self_awake:{legacy_id}"))
        .bind(last_error.as_deref())
        .bind(created_at)
        .bind(updated_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO self_awake_runs(
                id, job_id, session_id, schema_version, event_id, idempotency_key,
                status, request_json, decision_json, author_snapshot_json, attempts,
                last_error, started_at, completed_at, created_at, updated_at
             ) VALUES (?, ?, ?, 'legacy.moncore.v1', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        )
        .bind(&target_run_id)
        .bind(&target_job_id)
        .bind(&session_id)
        .bind(if external_run_id.trim().is_empty() {
            format!("legacy-self-awake-{legacy_id}")
        } else {
            external_run_id.clone()
        })
        .bind(format!("legacy:moncore:self_awake:{legacy_id}"))
        .bind(target_status)
        .bind(serde_json::to_string(&request)?)
        .bind(serde_json::to_string(&decision)?)
        .bind(serde_json::to_string(&author)?)
        .bind(last_error.as_deref())
        .bind(started_at)
        .bind(finished_at.or(Some(updated_at)))
        .bind(created_at)
        .bind(updated_at)
        .execute(&mut *transaction)
        .await?;

        if let Some(mut diary) = legacy_self_awake_diary(source, legacy_id).await? {
            diary.mood = mood.clone();
            let diary_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO self_awake_diaries(
                    id, run_id, session_id, assistant_id, character_id, title, content,
                    mood, metadata_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&diary_id)
            .bind(&target_run_id)
            .bind(&session_id)
            .bind(diary.assistant_id)
            .bind(diary.character_id)
            .bind(diary.title)
            .bind(diary.content)
            .bind(diary.mood)
            .bind(serde_json::to_string(&diary.metadata)?)
            .bind(diary.created_at)
            .execute(&mut *transaction)
            .await?;
            report.self_awake_diaries_imported += 1;
        }
        let mut next_seq: i64 = sqlx::query_scalar("SELECT next_seq FROM sessions WHERE id=?")
            .bind(&session_id)
            .fetch_one(&mut *transaction)
            .await?;
        append_imported_event(
            &mut transaction,
            &session_id,
            &mut next_seq,
            None,
            "self_awake.imported",
            json!({
                "runId":target_run_id,
                "legacyRunId":external_run_id,
                "status":target_status,
                "sourceStatus":source_status,
                "replayed":false,
            }),
            updated_at,
        )
        .await?;
        sqlx::query("UPDATE sessions SET next_seq=? WHERE id=?")
            .bind(next_seq)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await?;
        record_legacy_item(
            &mut transaction,
            "self_awake_run",
            &legacy_key,
            &target_run_id,
            json!({"state":"imported","replayed":false}),
        )
        .await?;
        transaction.commit().await?;
        report.self_awake_runs_imported += 1;
    }
    Ok(())
}

async fn legacy_self_awake_actions(
    source: &sqlx::SqlitePool,
    run_id: i64,
) -> Result<Vec<Value>, StoreError> {
    if !source_has_table(source, "Agent_self_awake_action").await? {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id, action_type, message, payload, status, error,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms
         FROM Agent_self_awake_action WHERE run_id=? ORDER BY id",
    )
    .bind(run_id)
    .fetch_all(source)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(json!({
                "legacyId":row.try_get::<i64,_>("id")?,
                "type":row.try_get::<String,_>("action_type")?,
                "message":row.try_get::<String,_>("message")?,
                "payload":redact_legacy_secrets(parse_json(row.try_get::<Option<String>,_>("payload")?.as_deref())),
                "status":row.try_get::<String,_>("status")?,
                "error":row.try_get::<Option<String>,_>("error")?,
                "createdAt":positive_time(row.try_get("created_at_ms")?),
            }))
        })
        .collect()
}

struct LegacyDiary {
    assistant_id: String,
    character_id: String,
    title: String,
    content: String,
    mood: String,
    metadata: Value,
    created_at: i64,
}

async fn legacy_self_awake_diary(
    source: &sqlx::SqlitePool,
    run_id: i64,
) -> Result<Option<LegacyDiary>, StoreError> {
    if !source_has_table(source, "Agent_self_awake_diary").await? {
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT id, title, content, summary, tags, importance, continuity_key,
                assistant_id, character_id,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms
         FROM Agent_self_awake_diary WHERE run_id=? ORDER BY id DESC LIMIT 1",
    )
    .bind(run_id)
    .fetch_optional(source)
    .await?;
    row.map(|row| {
        Ok(LegacyDiary {
            assistant_id: row
                .try_get::<Option<i64>, _>("assistant_id")?
                .map(|value| value.to_string())
                .unwrap_or_default(),
            character_id: row
                .try_get::<Option<i64>, _>("character_id")?
                .map(|value| value.to_string())
                .unwrap_or_default(),
            title: row.try_get("title")?,
            content: row.try_get("content")?,
            mood: String::new(),
            metadata: json!({"legacy":{
                "source":DOMAIN_SOURCE_KIND,
                "id":row.try_get::<i64,_>("id")?,
                "summary":row.try_get::<String,_>("summary")?,
                "tags":parse_json(row.try_get::<Option<String>,_>("tags")?.as_deref()),
                "importance":row.try_get::<String,_>("importance")?,
                "continuityKey":row.try_get::<String,_>("continuity_key")?,
            }}),
            created_at: positive_time(row.try_get("created_at_ms")?),
        })
    })
    .transpose()
}

async fn import_director_runs(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_director_run").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, external_plan_id, external_user_message_id, source, diagnostic,
                scene_payload, execution_payload, beats_payload, status,
                active_beat_index, completed_beat_indexes, participant_count, error,
                session_map_id,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_director_run ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "director_run", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let legacy_session_id: i64 = row.try_get("session_map_id")?;
        let Some(session_id) = target_session_for_legacy(store, source, legacy_session_id).await?
        else {
            report.domain_items_skipped += 1;
            continue;
        };
        let turn_id = Uuid::new_v4().to_string();
        let plan_id: String = row.try_get("external_plan_id")?;
        let user_message_id: String = row.try_get("external_user_message_id")?;
        let source_name: String = row.try_get("source")?;
        let diagnostic: Option<String> = row.try_get("diagnostic")?;
        let scene = parse_json(
            row.try_get::<Option<String>, _>("scene_payload")?
                .as_deref(),
        );
        let execution = parse_json(
            row.try_get::<Option<String>, _>("execution_payload")?
                .as_deref(),
        );
        let beats = parse_json(
            row.try_get::<Option<String>, _>("beats_payload")?
                .as_deref(),
        );
        let source_status: String = row.try_get("status")?;
        let completed_indexes = parse_json(
            row.try_get::<Option<String>, _>("completed_beat_indexes")?
                .as_deref(),
        );
        let participant_count: i64 = row.try_get("participant_count")?;
        let error: Option<String> = row.try_get("error")?;
        let created_at = positive_time(row.try_get("created_at_ms")?);
        let updated_at = positive_time(row.try_get("updated_at_ms")?).max(created_at);
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut next_seq: i64 = sqlx::query_scalar("SELECT next_seq FROM sessions WHERE id=?")
            .bind(&session_id)
            .fetch_one(&mut *transaction)
            .await?;
        append_imported_event(
            &mut transaction,
            &session_id,
            &mut next_seq,
            Some(&turn_id),
            "companion.director.started",
            json!({
                "sessionID":session_id,
                "participantCount":participant_count,
                "userMessageID":user_message_id,
                "imported":true,
            }),
            created_at,
        )
        .await?;
        append_imported_event(
            &mut transaction,
            &session_id,
            &mut next_seq,
            Some(&turn_id),
            "companion.plan",
            json!({
                "sessionID":session_id,
                "planID":plan_id,
                "userMessageID":user_message_id,
                "source":source_name,
                "diagnostic":diagnostic,
                "scene":scene,
                "execution":execution,
                "beats":beats,
                "imported":true,
            }),
            created_at,
        )
        .await?;
        let terminal_type = if matches!(source_status.as_str(), "completed" | "succeeded") {
            "companion.director.completed"
        } else {
            "companion.director.failed"
        };
        append_imported_event(
            &mut transaction,
            &session_id,
            &mut next_seq,
            Some(&turn_id),
            terminal_type,
            json!({
                "sessionID":session_id,
                "planID":plan_id,
                "status":source_status,
                "activeBeatIndex":row.try_get::<Option<i64>,_>("active_beat_index")?,
                "completedBeatIndexes":completed_indexes,
                "error":error,
                "imported":true,
            }),
            updated_at,
        )
        .await?;
        sqlx::query("UPDATE sessions SET next_seq=?, updated_at=MAX(updated_at, ?) WHERE id=?")
            .bind(next_seq)
            .bind(updated_at)
            .bind(&session_id)
            .execute(&mut *transaction)
            .await?;
        record_legacy_item(
            &mut transaction,
            "director_run",
            &legacy_key,
            &plan_id,
            json!({"state":"imported","sessionId":session_id}),
        )
        .await?;
        transaction.commit().await?;
        report.director_runs_imported += 1;
    }
    Ok(())
}

async fn import_connectors(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_connector").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, connector_key, identity_key, display_name, desired_state, runtime_state,
                settings, credential_reference, last_error,
                COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_connector ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "connector", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let target_id = Uuid::new_v4().to_string();
        let credential_reference: String = row.try_get("credential_reference")?;
        let source_desired_state: String = row.try_get("desired_state")?;
        let settings = redact_legacy_secrets(parse_json(
            row.try_get::<Option<String>, _>("settings")?.as_deref(),
        ));
        let migration_error = if !credential_reference.trim().is_empty() {
            Some("legacy credential reference was not imported; reconnect explicitly".to_owned())
        } else if source_desired_state == "connected" {
            Some("legacy connector was imported disconnected; reconnect explicitly".to_owned())
        } else {
            row.try_get::<Option<String>, _>("last_error")?
        };
        let created_at = positive_time(row.try_get("created_at_ms")?);
        let updated_at = positive_time(row.try_get("updated_at_ms")?).max(created_at);
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO connectors(
                id, connector_key, identity_key, display_name, desired_state, runtime_state,
                settings_json, last_error, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'disconnected', 'offline', ?, ?, ?, ?)",
        )
        .bind(&target_id)
        .bind(row.try_get::<String, _>("connector_key")?)
        .bind(row.try_get::<String, _>("identity_key")?)
        .bind(row.try_get::<String, _>("display_name")?)
        .bind(serde_json::to_string(&settings)?)
        .bind(migration_error.as_deref())
        .bind(created_at)
        .bind(updated_at)
        .execute(&mut *transaction)
        .await?;
        if source_has_table(source, "Agent_connector_event").await? {
            let events = sqlx::query(
                "SELECT id, external_event_id, event_type, payload, status, last_error,
                        COALESCE(CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER),0) AS created_at_ms,
                        COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
                 FROM Agent_connector_event WHERE connector_id=? ORDER BY id",
            )
            .bind(legacy_id)
            .fetch_all(source)
            .await?;
            for event in events {
                let legacy_event_id: i64 = event.try_get("id")?;
                let target_event_id = Uuid::new_v4().to_string();
                let source_status: String = event.try_get("status")?;
                let target_status = match source_status.as_str() {
                    "completed" => "completed",
                    "failed" => "failed",
                    _ => "failed",
                };
                let last_error = if matches!(source_status.as_str(), "pending" | "claimed") {
                    Some("legacy pending connector event was not replayed".to_owned())
                } else {
                    event.try_get::<Option<String>, _>("last_error")?
                };
                let external_id: String = event.try_get("external_event_id")?;
                sqlx::query(
                    "INSERT INTO connector_events(
                        id, connector_id, external_id, event_type, payload_json, status,
                        operation_id, lease_until, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)",
                )
                .bind(&target_event_id)
                .bind(&target_id)
                .bind(if external_id.trim().is_empty() {
                    format!("legacy-{legacy_event_id}")
                } else {
                    external_id
                })
                .bind(event.try_get::<String, _>("event_type")?)
                .bind(serde_json::to_string(&json!({
                    "legacyPayload":redact_legacy_secrets(parse_json(event.try_get::<Option<String>,_>("payload")?.as_deref())),
                    "legacyStatus":source_status,
                    "legacyError":last_error,
                }))?)
                .bind(target_status)
                .bind(positive_time(event.try_get("created_at_ms")?))
                .bind(positive_time(event.try_get("updated_at_ms")?))
                .execute(&mut *transaction)
                .await?;
                record_legacy_item(
                    &mut transaction,
                    "connector_event",
                    &legacy_event_id.to_string(),
                    &target_event_id,
                    json!({"state":"imported","replayed":false}),
                )
                .await?;
                report.connector_events_imported += 1;
            }
        }
        record_legacy_item(
            &mut transaction,
            "connector",
            &legacy_key,
            &target_id,
            json!({
                "state":"imported",
                "activated":false,
                "legacyDesiredState":source_desired_state,
                "credentialReferencePresent":!credential_reference.trim().is_empty(),
            }),
        )
        .await?;
        transaction.commit().await?;
        report.connectors_imported += 1;
    }
    Ok(())
}

async fn import_skill_installations(
    store: &Store,
    source: &sqlx::SqlitePool,
    report: &mut LegacyImportReport,
) -> Result<(), StoreError> {
    if !source_has_table(source, "Agent_skill_installation").await? {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT id, external_installation_id, skill_name, display_name, description, scope,
                source_type, source_uri, source_ref, installed_version, content_hash,
                enabled, trust_status, manifest_snapshot,
                COALESCE(CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER),0) AS updated_at_ms
         FROM Agent_skill_installation ORDER BY id",
    )
    .fetch_all(source)
    .await?;
    for row in rows {
        let legacy_id: i64 = row.try_get("id")?;
        let legacy_key = legacy_id.to_string();
        if legacy_item_exists(store, "skill_installation", &legacy_key).await? {
            report.domain_items_skipped += 1;
            continue;
        }
        let target_id = Uuid::new_v4().to_string();
        let enabled: bool = row.try_get("enabled")?;
        let external_id: String = row.try_get("external_installation_id")?;
        let manifest = redact_legacy_secrets(parse_json(
            row.try_get::<Option<String>, _>("manifest_snapshot")?
                .as_deref(),
        ));
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO legacy_skill_installations(
                id, legacy_key, skill_name, display_name, description, scope,
                source_type, source_uri, source_ref, installed_version, content_hash,
                was_enabled, trust_status, manifest_json, migration_state, imported_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&target_id)
        .bind(&legacy_key)
        .bind(row.try_get::<String, _>("skill_name")?)
        .bind(row.try_get::<String, _>("display_name")?)
        .bind(row.try_get::<String, _>("description")?)
        .bind(row.try_get::<String, _>("scope")?)
        .bind(row.try_get::<String, _>("source_type")?)
        .bind(redact_source_uri(&row.try_get::<String, _>("source_uri")?))
        .bind(row.try_get::<String, _>("source_ref")?)
        .bind(row.try_get::<String, _>("installed_version")?)
        .bind(row.try_get::<String, _>("content_hash")?)
        .bind(enabled)
        .bind(row.try_get::<String, _>("trust_status")?)
        .bind(serde_json::to_string(&manifest)?)
        .bind(if enabled {
            "requires_reinstall"
        } else {
            "disabled"
        })
        .bind(now_i64())
        .execute(&mut *transaction)
        .await?;
        record_legacy_item(
            &mut transaction,
            "skill_installation",
            &legacy_key,
            &target_id,
            json!({
                "state":"recorded",
                "activated":false,
                "externalInstallationId":external_id,
            }),
        )
        .await?;
        transaction.commit().await?;
        report.skills_recorded += 1;
    }
    Ok(())
}

fn redact_legacy_secrets(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                    let value = if [
                        "apikey",
                        "token",
                        "password",
                        "secret",
                        "authorization",
                        "credential",
                        "cookie",
                    ]
                    .iter()
                    .any(|sensitive| normalized.contains(sensitive))
                    {
                        Value::String("[RECONFIGURE]".to_owned())
                    } else {
                        redact_legacy_secrets(value)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(redact_legacy_secrets).collect())
        }
        value => value,
    }
}

fn redact_source_uri(value: &str) -> String {
    let without_query = value.split_once('?').map_or(value, |(base, _)| base);
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return without_query.to_owned();
    };
    let sanitized = remainder
        .rsplit_once('@')
        .map_or(remainder, |(_, host_and_path)| host_and_path);
    format!("{scheme}://{sanitized}")
}

fn now_i64() -> i64 {
    now_ms()
}

async fn load_legacy_messages(
    source: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<Vec<LegacyMessage>, StoreError> {
    let rows = sqlx::query(
        "SELECT id, external_message_id, kind, message_payload,
                COALESCE(CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER), 0) AS created_at_ms
         FROM Agent_message_map
         WHERE session_map_id=?
         ORDER BY created_at, id",
    )
    .bind(session_id)
    .fetch_all(source)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(LegacyMessage {
                id: row.try_get("id")?,
                external_message_id: row.try_get("external_message_id")?,
                kind: row.try_get("kind")?,
                message_payload: row.try_get("message_payload")?,
                created_at: row.try_get("created_at_ms")?,
            })
        })
        .collect()
}

async fn append_imported_event(
    transaction: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    next_seq: &mut i64,
    turn_id: Option<&str>,
    event_type: &str,
    payload: Value,
    created_at: i64,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO session_events(id, session_id, seq, turn_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(*next_seq)
    .bind(turn_id)
    .bind(event_type)
    .bind(serde_json::to_string(&payload)?)
    .bind(positive_time(created_at))
    .execute(&mut **transaction)
    .await?;
    *next_seq += 1;
    Ok(())
}

fn positive_time(value: i64) -> i64 {
    if value > 0 { value } else { now_ms() }
}

fn legacy_participants(session: &LegacySession) -> Vec<Value> {
    let payload = session
        .session_payload
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let participants = payload
        .as_ref()
        .and_then(|value| value.get("participants"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized: Vec<Value> = participants
        .iter()
        .filter_map(normalize_participant)
        .collect();
    if !normalized.is_empty() {
        return normalized;
    }
    session.assistant_id.map_or_else(Vec::new, |assistant_id| {
        vec![json!({
            "assistantId": assistant_id,
            "assistantName": "",
            "characterId": session.character_id,
            "characterName": "",
            "signature": "",
            "avatarUrl": "",
            "standingImageUrl": "",
            "position": 0,
        })]
    })
}

fn normalize_participant(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let read = |camel: &str, legacy: &str| {
        object
            .get(camel)
            .or_else(|| object.get(legacy))
            .cloned()
            .unwrap_or(Value::Null)
    };
    Some(json!({
        "assistantId": read("assistantId", "assistantID"),
        "assistantName": read("assistantName", "assistantName"),
        "characterId": read("characterId", "characterID"),
        "characterName": read("characterName", "characterName"),
        "signature": read("signature", "signature"),
        "avatarUrl": read("avatarUrl", "avatarUrl"),
        "standingImageUrl": read("standingImageUrl", "standingImageUrl"),
        "ttsConfigId": read("ttsConfigId", "ttsConfigID"),
        "position": read("position", "position"),
    }))
}

fn rewrite_legacy_session_id(message: &mut Value, session_id: &str) {
    if let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) {
        for part in parts {
            if let Some(object) = part.as_object_mut() {
                object.insert("sessionID".to_owned(), json!(session_id));
            }
        }
    }
}

fn runtime_message(api_message: &Value, role: &str, fallback_time: i64) -> Option<Value> {
    let content = api_message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(canonical_legacy_part)
        .collect::<Vec<_>>();
    let timestamp = api_message
        .pointer("/info/time/created")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| positive_time(fallback_time));
    match role {
        "user" => Some(json!({"role":"user", "content":content, "timestamp":timestamp})),
        "assistant" => {
            let mut message = json!({
                "role":"assistant",
                "content":content,
                "api":"legacy-moncore",
                "provider":api_message.pointer("/info/providerID").and_then(Value::as_str).unwrap_or(""),
                "model":api_message.pointer("/info/modelID").and_then(Value::as_str).unwrap_or(""),
                "stopReason":"stop",
                "timestamp":timestamp,
            });
            if let Some(object) = message.as_object_mut() {
                if let Some(speaker) = api_message
                    .pointer("/info/speaker")
                    .filter(|value| value.is_object())
                {
                    object.insert("speaker".to_owned(), speaker.clone());
                }
                if let Some(orchestration) =
                    api_message.pointer("/info/orchestration").filter(|value| {
                        value.is_object()
                            && value.as_object().is_some_and(|value| !value.is_empty())
                    })
                {
                    object.insert("orchestration".to_owned(), orchestration.clone());
                }
            }
            Some(message)
        }
        _ => None,
    }
}

fn parse_json(raw: Option<&str>) -> Value {
    raw.and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null)
}

fn legacy_title_source(session_payload: Option<&Value>) -> &'static str {
    match session_payload
        .and_then(|value| value.get("titleSource"))
        .and_then(Value::as_str)
    {
        Some("pending") => "pending",
        Some("generating") => "generating",
        Some("generated") => "generated",
        Some("fallback") => "fallback",
        Some("user") => "user",
        _ => "legacy",
    }
}

fn legacy_context_snapshots(session: &LegacySession) -> Vec<(Value, i64)> {
    parse_json(session.session_events_payload.as_deref())
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("context_snapshot"))
        .filter_map(|event| {
            let payload = event.get("payload")?.clone();
            let created_at = event
                .get("createdAt")
                .and_then(Value::as_i64)
                .unwrap_or(session.updated_at);
            Some((payload, created_at))
        })
        .collect()
}

fn legacy_character_states(session_payload: Option<&Value>, session_id: &str) -> Vec<Value> {
    let mut states = Vec::new();
    if let Some(performances) = session_payload
        .and_then(|value| value.get("characterPerformances"))
        .and_then(Value::as_object)
    {
        for (character_id, performance) in performances {
            if let Some(current) = performance.get("current").filter(|value| value.is_object()) {
                states.push(normalize_character_state(
                    current.clone(),
                    character_id,
                    session_id,
                ));
            }
        }
    }
    if states.is_empty()
        && let Some(current) = session_payload
            .and_then(|value| value.get("characterRuntime"))
            .filter(|value| value.is_object())
    {
        let character_id = current
            .get("characterID")
            .or_else(|| current.get("characterId"))
            .map(json_scalar)
            .unwrap_or_default();
        states.push(normalize_character_state(
            current.clone(),
            &character_id,
            session_id,
        ));
    }
    states
}

fn normalize_character_state(
    mut value: Value,
    fallback_character_id: &str,
    session_id: &str,
) -> Value {
    if let Some(object) = value.as_object_mut() {
        let character_id = object
            .get("characterId")
            .or_else(|| object.get("characterID"))
            .cloned()
            .unwrap_or_else(|| json!(fallback_character_id));
        object.insert("sessionId".to_owned(), json!(session_id));
        object.insert("characterId".to_owned(), character_id);
        object.insert("source".to_owned(), json!("legacy_import"));
    }
    value
}

fn json_scalar(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn canonical_legacy_part(part: &Value) -> Option<Value> {
    let kind = part.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => part
            .get("text")
            .and_then(Value::as_str)
            .map(|text| json!({"type":"text", "text":text})),
        "reasoning" => part
            .get("text")
            .and_then(Value::as_str)
            .map(|thinking| json!({"type":"thinking", "thinking":thinking, "source":"legacy"})),
        "tool" => Some(json!({
            "type":"toolCall",
            "id":part.get("id").and_then(Value::as_str).unwrap_or("legacy-tool-call"),
            "name":part.get("tool").and_then(Value::as_str).unwrap_or("legacy_tool"),
            "arguments":part.pointer("/state/input").cloned().unwrap_or_else(||json!({})),
        })),
        "file" => {
            let url = part.get("url").and_then(Value::as_str).unwrap_or("");
            let label = part
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("file");
            Some(json!({"type":"text", "text":format!("[{label}]({url})")}))
        }
        "sticker" => {
            let label = part
                .get("alt")
                .or_else(|| part.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("sticker");
            let url = part.get("url").and_then(Value::as_str).unwrap_or("");
            Some(json!({"type":"text", "text":format!("![{label}]({url})")}))
        }
        "snapshot" => part
            .get("snapshot")
            .and_then(Value::as_str)
            .map(|snapshot| json!({"type":"text", "text":snapshot})),
        _ => part
            .get("content")
            .or_else(|| part.get("text"))
            .and_then(Value::as_str)
            .map(|text| json!({"type":"text", "text":text})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn legacy_import_is_complete_and_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source_path = directory.path().join("core.sqlite3");
        let source = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&source_path)
                    .create_if_missing(true),
            )
            .await
            .expect("source");
        for statement in [
            "CREATE TABLE Agent_session_map(
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source TEXT NOT NULL,
                external_session_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
                session_payload TEXT, session_events_payload TEXT, director_policy TEXT, mode TEXT,
                assistant_id INTEGER, character_id INTEGER,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_message_map(
                id INTEGER PRIMARY KEY, external_message_id TEXT NOT NULL, kind TEXT NOT NULL,
                message_payload TEXT, created_at TEXT NOT NULL, session_map_id INTEGER NOT NULL)",
        ] {
            sqlx::query(statement)
                .execute(&source)
                .await
                .expect("schema");
        }
        sqlx::query(
            "INSERT INTO Agent_session_map VALUES(
                1, 7, 'monagent', 'ses_old', '旧会话', 'active', ?, '[]', '{}', 'companion', 3, 4,
                '2026-08-01 07:00:00', '2026-08-01 07:01:00')",
        )
        .bind(json!({"participants":[{"assistantID":3,"assistantName":"阿罗娜","characterID":4,"position":0}]}).to_string())
        .execute(&source)
        .await
        .expect("session");
        for (id, kind, text) in [(1, "user", "你好"), (2, "assistant", "你好，老师")] {
            let message_id = format!("msg_{id}");
            sqlx::query(
                "INSERT INTO Agent_message_map VALUES(?, ?, ?, ?, '2026-08-01 07:00:30', 1)",
            )
            .bind(id)
            .bind(&message_id)
            .bind(kind)
            .bind(json!({
                "info":{"id":message_id,"role":kind,"time":{"created":1_785_568_000_000_i64}},
                "parts":[{"id":format!("part_{id}"),"messageID":message_id,"sessionID":"ses_old","type":"text","text":text}]
            }).to_string())
            .execute(&source)
            .await
            .expect("message");
        }
        source.close().await;

        let target = Store::open(&directory.path().join("agent.db"))
            .await
            .expect("target");
        let first = target
            .import_legacy_moncore_sessions(&source_path)
            .await
            .expect("first import");
        assert_eq!(first.sessions_imported, 1);
        assert_eq!(first.messages_imported, 2);
        let second = target
            .import_legacy_moncore_sessions(&source_path)
            .await
            .expect("second import");
        assert_eq!(second.sessions_imported, 0);
        assert_eq!(second.sessions_skipped, 1);

        let sessions = target.list_sessions().await.expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].participants[0]["assistantId"], 3);
        let events = target.list_events(sessions[0].id, 0).await.expect("events");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == "agent.message_end")
                .count(),
            2
        );
        assert_eq!(events[0].payload["message"]["content"][0]["text"], "你好");
        assert_eq!(
            events[0].payload["legacy"]["originalMessage"]["parts"][0]["sessionID"],
            sessions[0].id.to_string()
        );
    }

    #[tokio::test]
    async fn legacy_domain_import_is_safe_complete_and_idempotent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let source_path = directory.path().join("core-domain.sqlite3");
        let source = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&source_path)
                    .create_if_missing(true),
            )
            .await
            .expect("source");
        let schemas = [
            "CREATE TABLE Agent_session_map(
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source TEXT NOT NULL,
                external_session_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
                session_payload TEXT, session_events_payload TEXT, director_policy TEXT, mode TEXT,
                assistant_id INTEGER, character_id INTEGER, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_message_map(
                id INTEGER PRIMARY KEY, external_message_id TEXT NOT NULL, kind TEXT NOT NULL,
                message_payload TEXT, created_at TEXT NOT NULL, session_map_id INTEGER NOT NULL)",
            "CREATE TABLE Agent_memory(
                id INTEGER PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL,
                content TEXT NOT NULL, source_session_id TEXT NOT NULL,
                source_message_ids TEXT, confidence REAL NOT NULL, sensitivity TEXT NOT NULL,
                metadata TEXT, assistant_id INTEGER, user_id INTEGER NOT NULL,
                agent_character_id INTEGER, scope_type TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_work_memory(
                id INTEGER PRIMARY KEY, scope TEXT NOT NULL, summary TEXT NOT NULL,
                open_threads TEXT, avoid_repeating TEXT, source TEXT NOT NULL,
                assistant_id INTEGER, character_id INTEGER, user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE user_memo(
                id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
                kind TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
                remind_at TEXT, due_at TEXT, repeat_rule TEXT NOT NULL, source TEXT NOT NULL,
                related_session_id TEXT NOT NULL, related_message_id TEXT NOT NULL,
                semantic_task_id TEXT NOT NULL, last_triggered_at TEXT, snoozed_until TEXT,
                completed_at TEXT, metadata TEXT, user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE user_agent_settings(
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, permission_mode TEXT NOT NULL,
                enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_self_awake_run(
                id INTEGER PRIMARY KEY, source_service TEXT NOT NULL,
                external_run_id TEXT NOT NULL, status TEXT NOT NULL, context_payload TEXT,
                decision_payload TEXT, mood TEXT NOT NULL, current_desire TEXT NOT NULL,
                should_interrupt_user INTEGER NOT NULL, next_wake_after_minutes INTEGER,
                next_wake_reason TEXT NOT NULL, error TEXT NOT NULL, assistant_id INTEGER,
                character_id INTEGER, user_id INTEGER NOT NULL, event_type TEXT NOT NULL,
                event_source TEXT NOT NULL, event_reason TEXT NOT NULL, event_id TEXT NOT NULL,
                started_at TEXT, finished_at TEXT, next_wake_at TEXT,
                event_occurred_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_self_awake_action(
                id INTEGER PRIMARY KEY, action_type TEXT NOT NULL, message TEXT NOT NULL,
                payload TEXT, status TEXT NOT NULL, error TEXT, run_id INTEGER NOT NULL,
                created_at TEXT NOT NULL)",
            "CREATE TABLE Agent_self_awake_diary(
                id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
                summary TEXT, tags TEXT, importance TEXT, continuity_key TEXT,
                assistant_id INTEGER, character_id INTEGER, run_id INTEGER NOT NULL,
                created_at TEXT NOT NULL)",
            "CREATE TABLE Agent_director_run(
                id INTEGER PRIMARY KEY, external_plan_id TEXT NOT NULL,
                external_user_message_id TEXT NOT NULL, source TEXT NOT NULL,
                diagnostic TEXT, scene_payload TEXT, execution_payload TEXT,
                beats_payload TEXT, status TEXT NOT NULL, active_beat_index INTEGER,
                completed_beat_indexes TEXT, participant_count INTEGER NOT NULL, error TEXT,
                session_map_id INTEGER NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_connector(
                id INTEGER PRIMARY KEY, connector_key TEXT NOT NULL, identity_key TEXT NOT NULL,
                display_name TEXT NOT NULL, desired_state TEXT NOT NULL,
                runtime_state TEXT NOT NULL, settings TEXT, credential_reference TEXT NOT NULL,
                last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_connector_event(
                id INTEGER PRIMARY KEY, external_event_id TEXT NOT NULL,
                event_type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
                last_error TEXT, connector_id INTEGER NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)",
            "CREATE TABLE Agent_skill_installation(
                id INTEGER PRIMARY KEY, external_installation_id TEXT NOT NULL,
                skill_name TEXT NOT NULL, display_name TEXT NOT NULL, description TEXT NOT NULL,
                scope TEXT NOT NULL, source_type TEXT NOT NULL, source_uri TEXT NOT NULL,
                source_ref TEXT NOT NULL, installed_version TEXT NOT NULL,
                content_hash TEXT NOT NULL, enabled INTEGER NOT NULL, trust_status TEXT NOT NULL,
                manifest_snapshot TEXT, updated_at TEXT NOT NULL)",
        ];
        for statement in schemas {
            sqlx::query(statement)
                .execute(&source)
                .await
                .expect("legacy domain schema");
        }

        let session_payload = json!({
            "participants":[{"assistantID":3,"characterID":4,"position":0}],
            "characterPerformances":{"4":{"current":{"mood":"calm"}}}
        });
        let context_events = json!([{
            "type":"context_snapshot",
            "createdAt":1_785_568_010_000_i64,
            "payload":{"skills":["legacy-observer"]}
        }]);
        sqlx::query(
            "INSERT INTO Agent_session_map VALUES(
                1, 7, 'monagent', 'ses_old', '历史会话', 'closed', ?, ?, '{}',
                'companion', 3, 4, '2026-08-01 07:00:00', '2026-08-01 07:01:00')",
        )
        .bind(session_payload.to_string())
        .bind(context_events.to_string())
        .execute(&source)
        .await
        .expect("session");
        sqlx::query(
            "INSERT INTO Agent_memory VALUES(
                1, 'character:4', 'semantic', 'legacy memory', 'ses_old', '[\"msg_old\"]',
                0.8, 'normal', '{}', 3, 7, 4, 'character',
                '2026-08-01 07:00:00', '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("memory");
        sqlx::query(
            "INSERT INTO Agent_work_memory VALUES(
                1, 'assistant:3', 'continue migration', NULL, NULL, 'agent', 3, NULL, 7,
                '2026-08-01 07:00:00', '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("work memory");
        sqlx::query(
            "INSERT INTO user_memo VALUES(
                1, 'migration reminder', 'verify after restart', 'reminder', 'active', 'high',
                '2026-08-02 07:00:00', NULL, '', 'legacy', 'ses_old', 'msg_old', 'task_old',
                NULL, NULL, NULL, '{}', 7, '2026-08-01 07:00:00',
                '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("memo");
        sqlx::query(
            "INSERT INTO user_agent_settings VALUES(
                1, 7, 'takeover', 1, '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("permission mode");
        sqlx::query(
            "INSERT INTO Agent_self_awake_run VALUES(
                1, 'moncore', 'awake_old', 'pending', ?, ?, 'focused', 'finish migration', 1,
                15, 'continue later', '', 3, 4, 7, 'timer', 'scheduler', 'periodic',
                'event_old', '2026-08-01 07:00:00', NULL, '2026-08-01 07:15:00',
                '2026-08-01 07:00:00', '2026-08-01 07:00:00',
                '2026-08-01 07:01:00')",
        )
        .bind(json!({"apiToken":"context-secret"}).to_string())
        .bind(json!({"password":"decision-secret"}).to_string())
        .execute(&source)
        .await
        .expect("self awake run");
        sqlx::query(
            "INSERT INTO Agent_self_awake_action VALUES(
                1, 'notify', 'hello', ?, 'pending', '', 1, '2026-08-01 07:00:30')",
        )
        .bind(json!({"secret":"action-secret"}).to_string())
        .execute(&source)
        .await
        .expect("self awake action");
        sqlx::query(
            "INSERT INTO Agent_self_awake_diary VALUES(
                1, 'legacy diary', 'continued migration', 'summary', '[\"migration\"]',
                'high', 'migration', 3, 4, 1, '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("self awake diary");
        sqlx::query(
            "INSERT INTO Agent_director_run VALUES(
                1, 'plan_old', 'msg_old', 'director', 'legacy plan', '{}', '{}', '[]',
                'completed', 0, '[0]', 1, '', 1, '2026-08-01 07:00:00',
                '2026-08-01 07:01:00')",
        )
        .execute(&source)
        .await
        .expect("director run");
        sqlx::query(
            "INSERT INTO Agent_connector VALUES(
                1, 'discord', 'legacy-account', 'Legacy Discord', 'connected', 'connected', ?,
                'vault://legacy-secret', '', '2026-08-01 07:00:00',
                '2026-08-01 07:01:00')",
        )
        .bind(json!({"api_key":"connector-secret","channel":"general"}).to_string())
        .execute(&source)
        .await
        .expect("connector");
        sqlx::query(
            "INSERT INTO Agent_connector_event VALUES(
                1, 'event_old', 'message', ?, 'pending', '', 1,
                '2026-08-01 07:00:00', '2026-08-01 07:01:00')",
        )
        .bind(json!({"password":"event-secret","text":"hello"}).to_string())
        .execute(&source)
        .await
        .expect("connector event");
        sqlx::query(
            "INSERT INTO Agent_skill_installation VALUES(
                1, 'skill_old', 'legacy-skill', 'Legacy Skill', 'legacy metadata', 'user',
                'git', 'https://user:pass@example.test/skill.git?token=secret', 'main', '1.0.0',
                'abc123', 1, 'trusted', ?, '2026-08-01 07:01:00')",
        )
        .bind(json!({"name":"legacy-skill","token":"skill-secret"}).to_string())
        .execute(&source)
        .await
        .expect("skill");

        let target = Store::open(&directory.path().join("agent-domain.db"))
            .await
            .expect("target");
        let first = target
            .import_legacy_moncore_data(&source_path)
            .await
            .expect("first domain import");
        assert_eq!(first.sessions_imported, 1);
        assert_eq!(first.memories_imported, 1);
        assert_eq!(first.work_memories_imported, 1);
        assert_eq!(first.memos_imported, 1);
        assert_eq!(first.permission_modes_imported, 1);
        assert_eq!(first.self_awake_runs_imported, 1);
        assert_eq!(first.self_awake_diaries_imported, 1);
        assert_eq!(first.director_runs_imported, 1);
        assert_eq!(first.connectors_imported, 1);
        assert_eq!(first.connector_events_imported, 1);
        assert_eq!(first.skills_recorded, 1);
        assert_eq!(first.character_states_imported, 1);

        let audit = target
            .legacy_migration_audit()
            .await
            .expect("migration audit");
        assert_eq!(audit.imported_sessions, 1);
        assert_eq!(audit.imported_domain_items, 9);
        assert_eq!(audit.skills_requiring_reinstall, 1);
        assert_eq!(audit.connectors_requiring_reconnect, 1);
        assert_eq!(audit.quarantined_work_items, 2);
        assert!(audit.permission_reauthorization_required);

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memories")
                .fetch_one(&target.pool)
                .await
                .expect("memory count"),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memos")
                .fetch_one(&target.pool)
                .await
                .expect("memo count"),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM app_config WHERE key='permission.mode'"
            )
            .fetch_one(&target.pool)
            .await
            .expect("active permission mode"),
            0
        );
        let legacy_permission: String = sqlx::query_scalar(
            "SELECT value_json FROM app_config WHERE key='legacy.permission.mode'",
        )
        .fetch_one(&target.pool)
        .await
        .expect("legacy permission");
        let legacy_permission: Value = serde_json::from_str(&legacy_permission).expect("JSON");
        assert_eq!(legacy_permission["mode"], "takeover");
        assert_eq!(legacy_permission["safeEffectiveMode"], "restricted");
        assert_eq!(legacy_permission["requiresExplicitReauthorization"], true);

        let (run_status, request_json, decision_json): (String, String, String) =
            sqlx::query_as("SELECT status, request_json, decision_json FROM self_awake_runs")
                .fetch_one(&target.pool)
                .await
                .expect("self awake run");
        assert_eq!(run_status, "failed");
        assert!(!request_json.contains("context-secret"));
        assert!(!decision_json.contains("decision-secret"));
        assert!(!decision_json.contains("action-secret"));
        assert!(request_json.contains("[RECONFIGURE]"));
        let diary_mood: String = sqlx::query_scalar("SELECT mood FROM self_awake_diaries")
            .fetch_one(&target.pool)
            .await
            .expect("diary mood");
        assert_eq!(diary_mood, "focused");

        let (desired_state, runtime_state, settings_json): (String, String, String) =
            sqlx::query_as("SELECT desired_state, runtime_state, settings_json FROM connectors")
                .fetch_one(&target.pool)
                .await
                .expect("connector");
        assert_eq!(desired_state, "disconnected");
        assert_eq!(runtime_state, "offline");
        assert!(!settings_json.contains("connector-secret"));
        assert!(settings_json.contains("[RECONFIGURE]"));
        let (event_status, event_payload): (String, String) =
            sqlx::query_as("SELECT status, payload_json FROM connector_events")
                .fetch_one(&target.pool)
                .await
                .expect("connector event");
        assert_eq!(event_status, "failed");
        assert!(!event_payload.contains("event-secret"));

        let (skill_state, skill_uri, skill_manifest): (String, String, String) = sqlx::query_as(
            "SELECT migration_state, source_uri, manifest_json FROM legacy_skill_installations",
        )
        .fetch_one(&target.pool)
        .await
        .expect("legacy skill");
        assert_eq!(skill_state, "requires_reinstall");
        assert_eq!(skill_uri, "https://example.test/skill.git");
        assert!(!skill_manifest.contains("skill-secret"));
        assert!(skill_manifest.contains("[RECONFIGURE]"));

        for event_type in [
            "context.skill_snapshot",
            "character.action.changed",
            "companion.director.started",
            "companion.plan",
            "companion.director.completed",
            "self_awake.imported",
        ] {
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM session_events WHERE event_type=?")
                    .bind(event_type)
                    .fetch_one(&target.pool)
                    .await
                    .expect("imported event");
            assert_eq!(count, 1, "missing imported event {event_type}");
        }

        let second = target
            .import_legacy_moncore_data(&source_path)
            .await
            .expect("second domain import");
        assert_eq!(second.sessions_imported, 0);
        assert_eq!(second.sessions_skipped, 1);
        assert_eq!(second.memories_imported, 0);
        assert_eq!(second.work_memories_imported, 0);
        assert_eq!(second.memos_imported, 0);
        assert_eq!(second.self_awake_runs_imported, 0);
        assert_eq!(second.director_runs_imported, 0);
        assert_eq!(second.connectors_imported, 0);
        assert_eq!(second.connector_events_imported, 0);
        assert_eq!(second.skills_recorded, 0);
        assert_eq!(second.permission_modes_imported, 0);
        assert_eq!(second.domain_items_skipped, 8);

        let legacy_run_status: String =
            sqlx::query_scalar("SELECT status FROM Agent_self_awake_run WHERE id=1")
                .fetch_one(&source)
                .await
                .expect("legacy run remains readable");
        let legacy_event_status: String =
            sqlx::query_scalar("SELECT status FROM Agent_connector_event WHERE id=1")
                .fetch_one(&source)
                .await
                .expect("legacy event remains readable");
        assert_eq!(legacy_run_status, "pending");
        assert_eq!(legacy_event_status, "pending");
        source.close().await;
    }
}
