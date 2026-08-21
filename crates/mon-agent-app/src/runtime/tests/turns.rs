use super::*;

#[tokio::test]
async fn submitted_input_runs_once_and_persists_replayable_context() {
    let store = Store::in_memory().await.expect("store");
    let session = store.create_session("actor").await.expect("session");
    let model = Arc::new(RecordingModel {
        requests: StdMutex::new(Vec::new()),
    });
    let runtime = SessionRuntime::new(
        store.clone(),
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        },
        model.clone(),
        ToolRegistry::new(),
        "system",
    );
    let mut notifications = runtime.subscribe();
    runtime
        .submit_turn(session.id, "first".to_owned(), json!([]))
        .await
        .expect("first turn");
    wait_for_completion(&mut notifications).await;
    runtime
        .submit_turn(session.id, "second".to_owned(), json!([]))
        .await
        .expect("second turn");
    wait_for_completion(&mut notifications).await;

    {
        let requests = model.requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].messages.len(), 2);
        assert_eq!(requests[1].messages.len(), 4);
        assert_eq!(requests[0].metadata["promptCache"]["epoch"], 0);
        assert_eq!(
            requests[1].metadata["promptCache"]["invalidationReason"],
            "stable"
        );
        assert!(
            requests[1].metadata["tokenBreakdown"]["identity"]
                .as_u64()
                .is_some()
        );
        assert!(
            requests[1].metadata["tokenBreakdown"]["history"]
                .as_u64()
                .is_some()
        );
    }
    let events = store.list_events(session.id, 0).await.expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "turn.completed")
            .count(),
        2
    );
    assert!(events.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    let mut active_message_id = None;
    for event in &events {
        let tracks_message = event
            .payload
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            != Some("toolResult");
        match event.event_type.as_str() {
            "agent.message_start" if tracks_message => active_message_id = Some(event.id),
            "agent.message_update" | "agent.message_end" if tracks_message => {
                assert_eq!(
                    event.payload.get("messageId").and_then(Value::as_str),
                    active_message_id.map(|id| id.to_string()).as_deref(),
                    "streamed message events must retain the message_start record id",
                );
                if event.event_type == "agent.message_end" {
                    active_message_id = None;
                }
            }
            _ => {}
        }
    }
    let cache_events = events
        .iter()
        .filter(|event| event.event_type == "context.cache_state")
        .collect::<Vec<_>>();
    assert_eq!(cache_events.len(), 2);
    assert_eq!(cache_events[0].payload["cache"]["epoch"], 0);
    assert_eq!(cache_events[1].payload["cache"]["epoch"], 0);
    let usage = events
        .iter()
        .rev()
        .find(|event| event.event_type == "context.usage_updated")
        .expect("context usage");
    let breakdown = &usage.payload["tokenBreakdown"];
    let accounted = ["character", "skills", "system", "tools", "history"]
        .into_iter()
        .map(|key| breakdown[key].as_u64().expect("token category"))
        .sum::<u64>();
    let adjustment = breakdown["providerAdjustment"]
        .as_i64()
        .expect("provider adjustment");
    assert_eq!(
        breakdown["providerInput"].as_i64().expect("provider input"),
        accounted as i64 + adjustment
    );
    assert_eq!(
        usage.payload["contextTokens"]
            .as_u64()
            .expect("context total"),
        breakdown["providerInput"].as_u64().expect("provider input")
            + breakdown["providerOutput"]
                .as_u64()
                .expect("provider output"),
    );
    assert_eq!(usage.payload["contextTokens"], 19_100);
    assert_eq!(breakdown["providerInput"], 19_000);
    assert_eq!(breakdown["providerOutput"], 100);
    assert_eq!(breakdown["cacheRead"], 16_384);
    assert_eq!(breakdown["cacheMiss"], 2_616);
    assert_eq!(breakdown["contextMeasurement"], "provider");
    let expected_hit_rate = 16_384.0 / 19_000.0;
    let actual_hit_rate = breakdown["cacheHitRate"].as_f64().expect("cache hit rate");
    assert!((actual_hit_rate - expected_hit_rate).abs() < f64::EPSILON);
    assert_eq!(breakdown["tokenizerModel"], "test");
}

#[tokio::test]
async fn skill_snapshot_is_persisted_once_and_replayed_stably() {
    let store = Store::in_memory().await.expect("store");
    let session = store.create_session("skills").await.expect("session");
    let model = Arc::new(RecordingModel {
        requests: StdMutex::new(Vec::new()),
    });
    let runtime = SessionRuntime::new(
        store.clone(),
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        },
        model.clone(),
        ToolRegistry::new(),
        "system\nAvailable skills:\n- test-skill: stable instructions\nUse load_skill before applying it.",
    );
    let mut notifications = runtime.subscribe();
    runtime
        .submit_turn(session.id, "first".to_owned(), json!([]))
        .await
        .expect("first turn");
    wait_for_completion(&mut notifications).await;
    runtime
        .submit_turn(session.id, "second".to_owned(), json!([]))
        .await
        .expect("second turn");
    wait_for_completion(&mut notifications).await;

    {
        let requests = model.requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert_eq!(
                request
                    .messages
                    .iter()
                    .filter(|message| matches!(message, Message::Custom { data }
                            if data.get("customType").and_then(Value::as_str) == Some("skillSnapshot")))
                    .count(),
                1,
            );
        }
    }
    let events = store.list_events(session.id, 0).await.expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "context.skill_snapshot")
            .count(),
        1,
    );
}

#[tokio::test]
async fn explicit_assistant_handoff_turn_exposes_only_real_handoff_tools() {
    let store = Store::in_memory().await.expect("store");
    let session = store
        .create_session("handoff routing")
        .await
        .expect("session");
    let model = Arc::new(RecordingModel {
        requests: StdMutex::new(Vec::new()),
    });
    let mut tools = ToolRegistry::new();
    for name in [
        "list_assistants",
        "switch_session_assistant",
        "list_character_actions",
        "switch_character_action",
        "send_character_sticker",
        "read",
    ] {
        tools.register(Arc::new(NamedTool(name)));
    }
    let runtime = SessionRuntime::new(
        store,
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        },
        model.clone(),
        tools,
        "system",
    );
    let mut notifications = runtime.subscribe();
    runtime
        .submit_turn(session.id, "帮我叫阿罗娜出来".to_owned(), json!([]))
        .await
        .expect("handoff turn");
    wait_for_completion(&mut notifications).await;

    let requests = model.requests.lock().expect("requests");
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(request.system_prompt.contains("# 本轮强制路由"));
    assert_eq!(request.metadata["assistantHandoffIntent"], true);
    assert_eq!(
        request
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["list_assistants", "switch_session_assistant"]
    );
}
