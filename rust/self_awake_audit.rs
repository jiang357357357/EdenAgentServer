//! Durable, rebuildable per-wake execution records. Only persisted execution events
//! are exported; model reasoning/message streams are deliberately not included.
use std::{path::{Path, PathBuf}, sync::Arc};
use eden_agent_store::Store;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct SelfAwakeAudit {
    store: Store,
    directory: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl SelfAwakeAudit {
    pub fn new(store: Store, database: &Path) -> Self {
        Self { store, directory: database.parent().unwrap_or(Path::new(".")).join("self-awake"), lock: Arc::new(Mutex::new(())) }
    }

    pub async fn export(&self, id: Uuid) -> anyhow::Result<Value> {
        let _guard = self.lock.lock().await;
        let run = self.store.get_self_awake_run(id).await?;
        let events = self.store.self_awake_execution_events(id).await?;
        let diaries = self.store.list_self_awake_diaries_for_run(id).await?;
        let tool_calls = events.iter().filter(|e| e.event_type == "agent.tool_execution_start").count();
        let record = redact(json!({
            "schemaVersion": 1, "runId": run.id, "jobId": run.job_id,
            "status": run.status, "attempts": run.attempts,
            "startedAt": run.started_at, "completedAt": run.completed_at,
            "updatedAt": run.updated_at, "error": run.last_error,
            "trigger": {"type": run.request["trigger"]["type"], "reason": run.request["trigger"]["reason"]},
            "decision": run.decision, "diaries": diaries,
            "notification": self.store.get_self_awake_notification(id).await?,
            "desktopReminders": self.store.desktop_reminders_for_run(id).await?,
            "toolCallCount": tool_calls, "events": events,
            "recordNote": "工具调用来自实际执行事件；行动决策不等于已经执行。敏感字段已遮蔽，长文本已截断。"
        }));
        tokio::fs::create_dir_all(&self.directory).await?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let path = self.directory.join(format!("{id}.json"));
        let bytes = serde_json::to_vec_pretty(&record)?;
        // Compare contents, not timestamps: retries and late turn-end events are
        // reflected even when the run's updated_at has not changed.
        if tokio::fs::read(&path).await.ok().as_deref() != Some(bytes.as_slice()) {
            let temporary = self.directory.join(format!(".{id}.tmp"));
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary).await?;
            use tokio::io::AsyncWriteExt;
            file.write_all(&bytes).await?;
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temporary, &path).await?;
        }
        Ok(json!({"path": path.to_string_lossy(), "record": record}))
    }

    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let mut offset = 0;
                loop {
                    let runs = match self.store.list_self_awake_runs(offset, 100, None).await {
                        Ok(runs) => runs,
                        Err(error) => { tracing::warn!(%error, "self-awake audit scan failed; will retry"); break; }
                    };
                    let count = runs.len();
                    for run in runs {
                        if let Err(error) = self.export(run.id).await {
                            tracing::warn!(run_id=%run.id, %error, "self-awake audit export failed; will retry");
                        }
                    }
                    if count < 100 { break; }
                    offset += 100;
                    tokio::task::yield_now().await;
                }
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        })
    }
}

fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
            let secret = ["password", "secret", "token", "apikey", "authorization", "cookie", "credential"].iter().any(|word| normalized.contains(word));
            (key, if secret { json!("[已遮蔽]") } else { redact(value) })
        }).collect()),
        Value::Array(values) => Value::Array(values.into_iter().map(redact).collect()),
        Value::String(text) => {
            let mut limited: String = text.chars().take(16_000).collect();
            if text.chars().count() > 16_000 { limited.push_str("\n[内容过长，已截断]"); }
            Value::String(limited)
        }
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn persists_isolated_attempts_and_recovers_failure_diary() {
        use eden_agent_core::TurnId;
        let directory = tempfile::tempdir().unwrap();
        let store = Store::in_memory().await.unwrap();
        let session = store.create_session("background").await.unwrap();
        let job = store.schedule_job("self_awake", Some(session.id), 0, json!({}), "first").await.unwrap();
        let run = store.start_self_awake_run(&job, "self-awake.v1", "event", json!({"trigger":{"reason":"测试"}}), json!({"assistantId":"18"})).await.unwrap();
        let turn = TurnId::new();
        store.append_event(session.id, Some(turn), "self_awake.started", json!({"runId":run.id})).await.unwrap();
        store.append_event(session.id, Some(turn), "agent.tool_execution_start", json!({"toolCallId":"call1","toolName":"terminal","args":{"command":"pwd","token":"private"}})).await.unwrap();
        store.append_event(session.id, Some(turn), "agent.tool_execution_end", json!({"toolCallId":"call1","result":"/workspace","isError":false})).await.unwrap();
        store.append_event(session.id, Some(turn), "agent.message_end", json!({"thinking":"must not export"})).await.unwrap();
        store.append_event(session.id, Some(TurnId::new()), "agent.tool_execution_start", json!({"toolName":"unrelated"})).await.unwrap();
        store.fail_self_awake_run(job.id, "test timeout").await.unwrap();
        let audit = SelfAwakeAudit::new(store.clone(), &directory.path().join("agent.db"));
        let exported = audit.export(run.id).await.unwrap();
        assert_eq!(exported["record"]["toolCallCount"], 1);
        assert_eq!(exported["record"]["events"].as_array().unwrap().len(), 3);
        assert_eq!(exported["record"]["diaries"][0]["title"], "自醒失败记录");
        assert!(!exported.to_string().contains("private"));
        let filename = exported["path"].as_str().unwrap();
        let saved: Value = serde_json::from_slice(&tokio::fs::read(filename).await.unwrap()).unwrap();
        assert_eq!(saved, exported["record"]);
        // A subsequent successful attempt replaces the failure diary, once.
        let retried = store.start_self_awake_run(&job, "self-awake.v1", "event", json!({}), json!({"assistantId":"18"})).await.unwrap();
        let turn2 = TurnId::new();
        store.append_event(session.id, Some(turn2), "self_awake.started", json!({"runId":run.id})).await.unwrap();
        store.complete_self_awake_run(&retried, json!({"action":"write_diary"}), Some(json!({"title":"已恢复","content":"重试成功"})), None, None).await.unwrap();
        let exported = audit.export(run.id).await.unwrap();
        assert_eq!(exported["record"]["status"], "completed");
        assert_eq!(exported["record"]["events"].as_array().unwrap().len(), 4);
        assert_eq!(exported["record"]["diaries"].as_array().unwrap().len(), 1);
        assert_eq!(exported["record"]["diaries"][0]["content"], "重试成功");
        tokio::fs::remove_file(filename).await.unwrap();
        audit.export(run.id).await.unwrap();
        assert!(Path::new(filename).exists());
        assert!(audit.export(Uuid::now_v7()).await.is_err());
        // File-system errors are visible and retryable, without undoing a completed run.
        let blocked = directory.path().join("blocked");
        tokio::fs::write(&blocked, "not a directory").await.unwrap();
        let mut unavailable = audit.clone(); unavailable.directory = blocked.clone();
        assert!(unavailable.export(run.id).await.is_err());
        assert_eq!(store.get_self_awake_run(run.id).await.unwrap().status, "completed");
        tokio::fs::remove_file(&blocked).await.unwrap();
        unavailable.export(run.id).await.unwrap();
    }

    #[test]
    fn masks_nested_secrets_and_bounds_output() {
        let value = redact(json!({"args":{"api_key":"private","name":"terminal"},"result":[{"accessToken":"private"}], "output":"x".repeat(20_000)}));
        assert_eq!(value["args"]["api_key"], "[已遮蔽]");
        assert_eq!(value["args"]["name"], "terminal");
        assert_eq!(value["result"][0]["accessToken"], "[已遮蔽]");
        assert!(value["output"].as_str().unwrap().len() < 17_000);
    }
}
