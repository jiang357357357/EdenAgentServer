use crate::{
    HostServices,
    core::CoreClient,
    tools::environment::{weather_context, weather_summary},
};
use eden_agent_core::{ToolCall, ToolCallContext};
use eden_agent_store::Store;
use reqwest::Client;
use serde_json::json;

mod host_tools {
    use super::*;
    use eden_agent_core::event_channel;
    use std::collections::BTreeSet;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn host_registers_every_tool_referenced_by_builtin_host_skills() {
        let store = Store::in_memory().await.expect("store");
        let host = HostServices::new(store, None, None).expect("host");
        let names = host
            .tools()
            .into_iter()
            .map(|tool| tool.definition().name)
            .collect::<BTreeSet<_>>();
        assert!(
            !names.contains("mon_core_request"),
            "arbitrary Core routes must not be exposed to the model"
        );
        for expected in [
            "dispatch_due_memos",
            "get_next_memo_wake",
            "get_self_awake_state",
            "list_assistants",
            "switch_session_assistant",
            "analyze_image",
            "contact_user",
            "send_external_email",
            "send_qq_message",
            "list_character_actions",
            "send_character_sticker",
            "get_calendar_context",
            "get_weather",
        ] {
            assert!(names.contains(expected), "missing host tool: {expected}");
        }
    }

    #[tokio::test]
    async fn calendar_tool_uses_the_persisted_session_environment() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_environment(
                "calendar",
                Vec::new(),
                json!({"timezone":"Asia/Shanghai","locale":"zh-CN","location":{"city":"上海"}}),
            )
            .await
            .expect("session");
        let host = HostServices::new(store, None, None).expect("host");
        let calendar = host
            .tools()
            .into_iter()
            .find(|tool| tool.definition().name == "get_calendar_context")
            .expect("calendar tool");
        let (events, _receiver) = event_channel(8);
        let output = calendar
            .execute(
                &ToolCall {
                    id: "calendar-1".to_owned(),
                    name: "get_calendar_context".to_owned(),
                    arguments: json!({"date":"2024-09-17"}),
                },
                ToolCallContext {
                    cancellation: CancellationToken::new(),
                    events,
                    session_id: Some(session.id.to_string()),
                    metadata: json!({"agentPath":"/root"}),
                },
            )
            .await
            .expect("calendar output");
        assert_eq!(output.details["timezone"], "Asia/Shanghai");
        assert!(
            output.details["festivals"]
                .as_array()
                .expect("festivals")
                .iter()
                .any(|item| item["name"] == "中秋节")
        );
    }

    #[test]
    fn weather_summary_normalizes_open_meteo_fields() {
        let summary = weather_summary(&json!({
            "location":{"city":"上海","country":"中国"},
            "current":{
                "weather_code":2,
                "temperature_2m":26.5,
                "apparent_temperature":27.0,
                "relative_humidity_2m":60,
                "precipitation":0,
                "wind_speed_10m":8.2
            },
            "daily":{
                "time":["2026-08-19"],
                "weather_code":[2],
                "temperature_2m_min":[22],
                "temperature_2m_max":[29],
                "precipitation_sum":[0]
            }
        }));
        assert!(summary.contains("上海 · 中国"));
        assert!(summary.contains("局部多云"));
        assert!(summary.contains("22-29°C"));
    }

    #[tokio::test]
    async fn weather_never_combines_partial_request_coordinates_with_stored_coordinates() {
        let error = weather_context(
            &Client::new(),
            &json!({"latitude":31.23}),
            &json!({"location":{"city":"上海","longitude":121.47}}),
            &CancellationToken::new(),
        )
        .await
        .expect_err("partial coordinates must be rejected before a network request");
        assert_eq!(error.info.code, "incomplete_coordinates");
    }

    #[tokio::test]
    async fn self_awake_timer_persists_reason_and_uses_operation_identity() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("timer").await.expect("session");
        let host = HostServices::new(store.clone(), None, None).expect("host");
        let timer = host
            .tools()
            .into_iter()
            .find(|tool| tool.definition().name == "set_self_awake_timer")
            .expect("timer tool");
        let (events, _receiver) = event_channel(8);
        timer
            .execute(
                &ToolCall {
                    id: "timer-call-1".to_owned(),
                    name: "set_self_awake_timer".to_owned(),
                    arguments: json!({"afterMinutes":30,"reason":"检查游戏观察状态"}),
                },
                ToolCallContext {
                    cancellation: CancellationToken::new(),
                    events,
                    session_id: Some(session.id.to_string()),
                    metadata: json!({"operationId":"timer-operation-1"}),
                },
            )
            .await
            .expect("timer output");
        let jobs = store.list_jobs(Some("self_awake"), 10).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs[0].idempotency_key,
            format!("self-awake:{}:timer-operation-1", session.id)
        );
        assert_eq!(jobs[0].payload["trigger"]["reason"], "检查游戏观察状态");
        assert_eq!(jobs[0].payload["trigger"]["requestedBy"], "agent");
    }

    #[tokio::test]
    async fn memory_tools_are_character_scoped_and_subagents_are_read_only() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_participants(
                "memory",
                vec![json!({"assistantId":3,"characterId":7})],
            )
            .await
            .expect("session");
        store
            .create_memory(
                "另一个角色的秘密",
                "fact",
                "agent_character",
                "8",
                "other",
                json!({}),
            )
            .await
            .expect("other memory");
        let host = HostServices::new(store.clone(), None, None).expect("host");
        let tools = host.tools();
        let remember = tools
            .iter()
            .find(|tool| tool.definition().name == "remember_memory")
            .expect("remember");
        let search = tools
            .iter()
            .find(|tool| tool.definition().name == "search_memories")
            .expect("search");
        let (events, _receiver) = event_channel(8);
        let root = ToolCallContext {
            cancellation: CancellationToken::new(),
            events: events.clone(),
            session_id: Some(session.id.to_string()),
            metadata: json!({"agentPath":"/root"}),
        };
        remember
            .execute(
                &ToolCall {
                    id: "call-1".to_owned(),
                    name: "remember_memory".to_owned(),
                    arguments: json!({"content":"用户偏好简洁回答","scopeType":"global"}),
                },
                root.clone(),
            )
            .await
            .expect("remember");
        let memories = store
            .search_memories_in_scope("agent_character", "7", None, 10)
            .await
            .expect("scoped memories");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].content, "用户偏好简洁回答");

        let found = search
            .execute(
                &ToolCall {
                    id: "call-2".to_owned(),
                    name: "search_memories".to_owned(),
                    arguments: json!({}),
                },
                root,
            )
            .await
            .expect("search");
        assert!(!found.details.to_string().contains("另一个角色的秘密"));

        let subagent = ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: Some(session.id.to_string()),
            metadata: json!({"agentPath":"/root/research"}),
        };
        let error = remember
            .execute(
                &ToolCall {
                    id: "call-3".to_owned(),
                    name: "remember_memory".to_owned(),
                    arguments: json!({"content":"不得写入"}),
                },
                subagent,
            )
            .await
            .expect_err("subagent write must fail");
        assert_eq!(error.info.code, "blocked");
    }
}
#[tokio::test]
async fn dynamic_core_credentials_are_shared_and_session_scoped() {
    let store = Store::in_memory().await.expect("store");
    let host = HostServices::new(store, None, None).expect("host");
    let existing_tool_host = host.clone();
    assert!(
        existing_tool_host
            .core_client(Some("session-a"))
            .await
            .is_none()
    );

    host.bind_core_credentials(None, "http://127.0.0.1:41001/", "default-token")
        .await
        .expect("bind default");
    host.bind_core_credentials(
        Some("session-a"),
        "http://127.0.0.1:41002/",
        "session-token",
    )
    .await
    .expect("bind session");

    let session = existing_tool_host
        .core_client(Some("session-a"))
        .await
        .expect("session credential");
    let fallback = existing_tool_host
        .core_client(Some("session-b"))
        .await
        .expect("default credential");
    assert_eq!(session.base.as_str(), "http://127.0.0.1:41002/");
    assert_eq!(session.token.as_ref(), "session-token");
    assert_eq!(fallback.base.as_str(), "http://127.0.0.1:41001/");
    assert_eq!(fallback.token.as_ref(), "default-token");

    host.unbind_session_core_credentials("session-a").await;
    let unbound = existing_tool_host
        .core_client(Some("session-a"))
        .await
        .expect("default after unbind");
    assert_eq!(unbound.token.as_ref(), "default-token");
}

#[tokio::test]
async fn realtime_stt_url_is_server_side_and_uses_the_session_credential() {
    let store = Store::in_memory().await.expect("store");
    let host = HostServices::new(store, None, None).expect("host");
    host.bind_core_credentials(
        Some("session-a"),
        "https://core.example.test/root/",
        "Token secret value",
    )
    .await
    .expect("bind session");

    let url = host
        .realtime_stt_url("session-a")
        .await
        .expect("realtime URL");
    assert_eq!(
        url,
        "wss://core.example.test/root/ws/stt/realtime/?token=secret+value"
    );
}

#[tokio::test]
async fn core_audio_fetch_rejects_cross_origin_and_non_media_urls() {
    let client = CoreClient::new(Client::new(), "https://core.example.test/", "secret-token")
        .expect("Core client");
    let cross_origin = client
        .fetch_audio("https://attacker.example/audio.wav")
        .await
        .expect_err("cross-origin audio must be rejected");
    assert!(cross_origin.contains("outside"));
    let api_path = client
        .fetch_audio("/api/users/me/profile/")
        .await
        .expect_err("non-media Core paths must be rejected");
    assert!(api_path.contains("outside"));
}
