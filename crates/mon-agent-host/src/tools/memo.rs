use crate::{
    HostServices,
    support::{
        DefaultString, integer, limit, now_ms, optional_string, output, store_failure, string,
        timestamp,
    },
};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use mon_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use mon_agent_domain::SessionId;
use mon_agent_store::{MemoInput, MemoRecord};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone, Copy)]
enum MemoAction {
    Create,
    CreateReminder,
    List,
    ListDue,
    Complete,
    Archive,
    Snooze,
    MarkTriggered,
    Dispatch,
    NextWake,
}
impl MemoAction {
    const ALL: [Self; 10] = [
        Self::Create,
        Self::CreateReminder,
        Self::List,
        Self::ListDue,
        Self::Complete,
        Self::Archive,
        Self::Snooze,
        Self::MarkTriggered,
        Self::Dispatch,
        Self::NextWake,
    ];
}

struct MemoTool {
    host: HostServices,
    action: MemoAction,
}

#[async_trait]
impl Tool for MemoTool {
    fn definition(&self) -> ToolDefinition {
        let (name, description, required) = match self.action {
            MemoAction::Create => (
                "create_memo",
                "Create a durable note, reminder, or todo",
                vec!["title"],
            ),
            MemoAction::CreateReminder => (
                "create_reminder",
                "Create a durable scheduled reminder",
                vec!["title", "remindAt"],
            ),
            MemoAction::List => ("list_memos", "Search durable memos", vec![]),
            MemoAction::ListDue => ("list_due_memos", "List reminders due before a time", vec![]),
            MemoAction::Complete => ("complete_memo", "Mark a memo completed", vec!["id"]),
            MemoAction::Archive => ("archive_memo", "Archive a memo", vec!["id"]),
            MemoAction::Snooze => ("snooze_memo", "Snooze a reminder", vec!["id"]),
            MemoAction::MarkTriggered => (
                "mark_memo_triggered",
                "Mark a reminder delivered",
                vec!["id"],
            ),
            MemoAction::Dispatch => (
                "dispatch_due_memos",
                "Return due reminders and optionally mark them dispatched",
                vec![],
            ),
            MemoAction::NextWake => (
                "get_next_memo_wake",
                "Return the next pending reminder wake time",
                vec![],
            ),
        };
        let mut definition = ToolDefinition::direct(name, description);
        definition.parameters = json!({"type":"object","required":required,"properties":{
            "id":{"type":"integer"},"title":{"type":"string"},"content":{"type":"string"},
            "kind":{"type":"string","enum":["note","reminder","todo"]},
            "status":{"type":"string","enum":["active","done","archived","cancelled"]},
            "priority":{"type":"string","enum":["low","normal","high"]},
            "remindAt":{"type":["string","integer","null"]},"dueAt":{"type":["string","integer","null"]},
            "repeatRule":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},
            "before":{"type":["string","integer"]},"until":{"type":["string","integer"]},"minutes":{"type":"integer"},
            "after":{"type":["string","integer"]},"markDispatched":{"type":"boolean"},
            "metadata":{"type":"object"}
        }});
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        if matches!(
            self.action,
            MemoAction::List | MemoAction::ListDue | MemoAction::NextWake
        ) {
            return None;
        }
        Some(PermissionRequest {
            permission: "memo.write".to_owned(),
            patterns: vec![
                arguments
                    .get("id")
                    .map_or_else(|| "new".to_owned(), Value::to_string),
            ],
            always: vec!["*".to_owned()],
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let args = &call.arguments;
        let result = match self.action {
            MemoAction::Create | MemoAction::CreateReminder => {
                let reminder = matches!(self.action, MemoAction::CreateReminder);
                let session = context.session_id.unwrap_or_default();
                let input = MemoInput {
                    title: string(args, "title")?,
                    content: optional_string(args, "content"),
                    kind: if reminder {
                        "reminder".to_owned()
                    } else {
                        optional_string(args, "kind").or_default_to("note")
                    },
                    status: "active".to_owned(),
                    priority: optional_string(args, "priority").or_default_to("normal"),
                    remind_at: timestamp(args.get("remindAt"))?,
                    due_at: timestamp(args.get("dueAt"))?,
                    repeat_rule: optional_string(args, "repeatRule"),
                    source: "monagent".to_owned(),
                    related_session_id: session.clone(),
                    metadata: args.get("metadata").cloned().unwrap_or_else(|| json!({})),
                };
                let memo = self
                    .host
                    .store
                    .create_memo(input)
                    .await
                    .map_err(store_failure)?;
                if let Some(due_at) = memo.remind_at.or(memo.due_at) {
                    let session_id = session.parse::<SessionId>().ok();
                    self.host
                        .store
                        .schedule_job(
                            "memo.reminder",
                            session_id,
                            due_at,
                            json!({"memoId":memo.id}),
                            &format!("memo:{}", memo.id),
                        )
                        .await
                        .map_err(store_failure)?;
                }
                serde_json::to_value(memo).unwrap_or_default()
            }
            MemoAction::List => serde_json::to_value(
                self.host
                    .store
                    .list_memos(limit(args), args.get("query").and_then(Value::as_str))
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoAction::ListDue => serde_json::to_value(
                self.host
                    .store
                    .due_memos(
                        timestamp(args.get("before"))?.unwrap_or_else(now_ms),
                        limit(args),
                    )
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoAction::Complete => serde_json::to_value(
                self.host
                    .store
                    .update_memo(integer(args, "id")?, json!({"status":"done"}))
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoAction::Archive => serde_json::to_value(
                self.host
                    .store
                    .update_memo(integer(args, "id")?, json!({"status":"archived"}))
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoAction::Snooze => {
                let until = timestamp(args.get("until"))?
                    .or_else(|| {
                        args.get("minutes").and_then(Value::as_i64).map(|minutes| {
                            (Utc::now() + Duration::minutes(minutes)).timestamp_millis()
                        })
                    })
                    .ok_or_else(|| {
                        ToolFailure::new("invalid_snooze", "until or minutes is required")
                    })?;
                let memo = self
                    .host
                    .store
                    .get_memo(integer(args, "id")?)
                    .await
                    .map_err(store_failure)?;
                self.host
                    .store
                    .schedule_job(
                        "memo.reminder",
                        memo.related_session_id.parse().ok(),
                        until,
                        json!({"memoId":memo.id}),
                        &format!("memo:{}", memo.id),
                    )
                    .await
                    .map_err(store_failure)?;
                serde_json::to_value(
                    self.host
                        .store
                        .update_memo(memo.id, json!({"remindAt":until}))
                        .await
                        .map_err(store_failure)?,
                )
                .unwrap_or_default()
            }
            MemoAction::MarkTriggered => serde_json::to_value(
                self.host
                    .store
                    .mark_memo_triggered(integer(args, "id")?)
                    .await
                    .map_err(store_failure)?,
            )
            .unwrap_or_default(),
            MemoAction::Dispatch => {
                let before = timestamp(args.get("before"))?.unwrap_or_else(now_ms);
                let memos = self
                    .host
                    .store
                    .due_memos(before, limit(args))
                    .await
                    .map_err(store_failure)?;
                let mark_dispatched = args
                    .get("markDispatched")
                    .or_else(|| args.get("mark_dispatched"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if mark_dispatched {
                    for memo in &memos {
                        self.host
                            .store
                            .mark_memo_triggered(memo.id)
                            .await
                            .map_err(store_failure)?;
                    }
                }
                let next = self
                    .host
                    .store
                    .next_memo_wake(before)
                    .await
                    .map_err(store_failure)?;
                json!({
                    "memos": memos,
                    "dispatchedCount": memos.len(),
                    "markDispatched": mark_dispatched,
                    "nextWakeAt": next.as_ref().and_then(memo_trigger_at),
                    "nextMemo": next,
                })
            }
            MemoAction::NextWake => {
                let after = timestamp(args.get("after"))?.unwrap_or_else(now_ms);
                let memo = self
                    .host
                    .store
                    .next_memo_wake(after)
                    .await
                    .map_err(store_failure)?;
                json!({
                    "nextWakeAt": memo.as_ref().and_then(memo_trigger_at),
                    "memo": memo,
                })
            }
        };
        Ok(output(result))
    }
}

fn memo_trigger_at(memo: &MemoRecord) -> Option<i64> {
    memo.snoozed_until.or(memo.remind_at).or(memo.due_at)
}

pub(super) fn tools(host: HostServices) -> Vec<Arc<dyn Tool>> {
    MemoAction::ALL
        .iter()
        .copied()
        .map(|action| {
            Arc::new(MemoTool {
                host: host.clone(),
                action,
            }) as Arc<dyn Tool>
        })
        .collect()
}
