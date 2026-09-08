use super::*;
use eden_agent_core::{Tool, ToolCall, ToolCallContext, ToolFailure, ToolOutput};

pub(crate) struct SelfAwakeContextTool(pub Store);

fn activity_section(snapshot: &Value, section: &str) -> Value {
    let payload = &snapshot["payload"];
    let mut data = json!({});
    let keys: &[&str] = match section {
        "desktop_window" => &["foreground_window"],
        "desktop_session" => &["system_input", "session"],
        "audio_state" => &["media"],
        "recent_events" => &["recent_events"],
        _ => &[],
    };
    for key in keys {
        data[*key] = payload.get(*key).cloned().unwrap_or(Value::Null);
    }
    if section == "audio_state" {
        data["monagent"] = json!({
            "voice_recording":payload.pointer("/monagent/voice_recording"),
            "tts_playing":payload.pointer("/monagent/tts_playing")
        });
    }
    json!({
        "section":section, "source":"core.activity-presence",
        "available":snapshot.get("available").cloned().unwrap_or(json!(false)),
        "captured_at":snapshot.get("captured_at"), "received_at":snapshot.get("received_at"),
        "data":data,
        "interpretation":"This is the last reported snapshot, not a live microphone probe. Check captured_at for age. Null/unavailable means unknown. False means inactive at capture time. Legacy changed_fields alone is not evidence that an activity started. No audio content is included; do not infer speech or intent."
    })
}

impl SelfAwakeContextTool {
    async fn read(&self, call: &ToolCall, context: ToolCallContext) -> Result<Value> {
        let section = call.arguments["section"]
            .as_str()
            .context("section required")?;
        anyhow::ensure!(
            [
                "desktop_window",
                "desktop_session",
                "audio_state",
                "recent_events",
                "recent_diaries",
                "recent_contacts"
            ]
            .contains(&section),
            "unsupported context section"
        );
        let session_id: SessionId = context
            .session_id
            .as_deref()
            .context("session required")?
            .parse()?;
        let session = self.0.get_session(session_id).await?;
        // Never expose the personal Core identity to local/ordinary sessions.
        anyhow::ensure!(
            session.runtime_origin == SessionRuntimeOrigin::Mon
                && session.environment["sessionPurpose"] == "self_awake",
            "self-awake context requires a Mon background session"
        );
        let user = std::env::var("MON_SERVICE_USER_ID").unwrap_or_default();
        anyhow::ensure!(
            !user.is_empty()
                && session.environment["selfAwakeUserId"].as_str() == Some(user.as_str()),
            "self-awake context owner mismatch"
        );
        if section == "recent_contacts" {
            return Ok(json!({"section":section,"contacts":self.0.self_awake_contact_history(session_id,10).await?,
                "note":"Delivery acceptance is not proof of reading or a reply. Consider recent unanswered contact before another casual message; query QQ replies when relevant."}));
        }
        if section == "recent_diaries" {
            let limit = call.arguments["limit"].as_u64().unwrap_or(3).clamp(1, 5) as u32;
            let diaries = self.0.list_self_awake_diaries(session_id, limit).await?;
            return Ok(
                json!({"section":section,"source":"agent.diaries","diaries":diaries,
                "interpretation":"Historical attributed diary entries, not fresh observations. A different author's diary is a handover note, not your experience. Claims in diaries may be wrong."}),
            );
        }
        let (client, base, token, bound_user) = self_awake_bridge::core_identity().await?;
        anyhow::ensure!(bound_user == user, "Core context owner mismatch");
        let snapshot: Value = client
            .get(format!("{base}/api/users/me/activity-presence/"))
            .header("Authorization", format!("Token {token}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(activity_section(&snapshot, section))
    }
}

#[async_trait::async_trait]
impl Tool for SelfAwakeContextTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "get_self_awake_context",
            "自醒时按需读取一个信息类别：前台窗口、空闲/锁屏、录音播放状态、近期事件、历史日记或近期联系记录。只读取确实需要的类别；状态不包含音频内容，历史事件不等于当前活动。",
        );
        definition.parameters = json!({"type":"object","required":["section"],"additionalProperties":false,"properties":{
            "section":{"type":"string","enum":["desktop_window","desktop_session","audio_state","recent_events","recent_diaries","recent_contacts"]},
            "limit":{"type":"integer","minimum":1,"maximum":5,"description":"历史日记条数，默认 3"}
        }});
        definition
    }
    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let value = self
            .read(call, context)
            .await
            .map_err(|error| ToolFailure::new("self_awake_context_failed", error.to_string()))?;
        let mut output = ToolOutput::text(serde_json::to_string_pretty(&value).unwrap_or_default());
        output.details = value.clone();
        output.structured_content = Some(value);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn rejects_ordinary_sessions_before_accessing_core() {
        let store = Store::in_memory().await.unwrap();
        let session = store
            .create_session_with_runtime_origin(
                "chat",
                vec![],
                json!({}),
                SessionRuntimeOrigin::Mon,
            )
            .await
            .unwrap();
        let (events, _) = eden_agent_core::event_channel(8);
        let result = SelfAwakeContextTool(store)
            .read(
                &ToolCall {
                    id: "read-context".into(),
                    name: "get_self_awake_context".into(),
                    arguments: json!({"section":"audio_state"}),
                },
                ToolCallContext {
                    cancellation: tokio_util::sync::CancellationToken::new(),
                    events,
                    session_id: Some(session.id.to_string()),
                    metadata: json!({}),
                },
            )
            .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("background session")
        );
    }
    #[test]
    fn returns_only_requested_facts_with_unknowns_and_timestamp() {
        let snapshot = json!({"available":true,"captured_at":"2026-09-08T07:39:12Z","payload":{
            "foreground_window":{"window_title":"private.rs"},"session":{"locked":false},
            "monagent":{"voice_recording":false,"tts_playing":false},
            "media":{"available":false,"microphone_in_use":null},
            "recent_events":[{"changed_fields":["voice_recording"]}]
        }});
        let audio = activity_section(&snapshot, "audio_state");
        assert_eq!(audio["data"]["monagent"]["voice_recording"], false);
        assert!(audio["data"]["media"]["microphone_in_use"].is_null());
        assert!(!audio.to_string().contains("private.rs"));
        assert!(audio["data"].get("recent_events").is_none());
        assert_eq!(audio["captured_at"], snapshot["captured_at"]);
        let window = activity_section(&snapshot, "desktop_window");
        assert!(window["data"].get("monagent").is_none());
        assert_eq!(
            activity_section(&json!({}), "audio_state")["available"],
            false
        );
    }
    #[tokio::test]
    async fn remaining_tools_audit_background_context() {
        // The production owner comes from the process environment. Isolate it in
        // a child test process rather than racing other tests with set_var.
        if std::env::var("EDEN_CONTEXT_AUDIT_CHILD").as_deref()!=Ok("1") {
            let result=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact","self_awake_context::tests::remaining_tools_audit_background_context","--nocapture"])
                .env("EDEN_CONTEXT_AUDIT_CHILD","1").env("MON_SERVICE_USER_ID","audit-owner")
                .output().unwrap();
            assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
            assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed"));
            return;
        }
        let store=Store::in_memory().await.unwrap();
        let session=store.create_session_with_runtime_origin("audit",vec![],
            json!({"sessionPurpose":"self_awake","selfAwakeUserId":"audit-owner"}),SessionRuntimeOrigin::Mon).await.unwrap();
        for section in ["recent_diaries","recent_contacts"] {
            let (events,_)=eden_agent_core::event_channel(8);
            let output=SelfAwakeContextTool(store.clone()).execute(&ToolCall{
                id:section.into(),name:"get_self_awake_context".into(),arguments:json!({"section":section})
            },ToolCallContext{events,session_id:Some(session.id.to_string()),metadata:json!({}),
                cancellation:tokio_util::sync::CancellationToken::new()}).await.unwrap();
            assert_eq!(output.details["section"],section);
        }
    }

}
