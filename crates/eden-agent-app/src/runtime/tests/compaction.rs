use super::*;

#[tokio::test]
async fn filtered_history_preserves_context_and_actor_metadata_across_compaction() {
    use crate::runtime::context::{
        director_conversation_context, latest_prompt_cache_states, latest_skill_snapshots,
        rebuild_context,
    };
    let store = Store::in_memory().await.unwrap();
    let session = store.create_session("long history").await.unwrap();
    let mut retained = None;
    for index in 0..80 {
        let turn = TurnId::new();
        let event = store
            .append_event(
                session.id,
                Some(turn),
                "agent.message_end",
                json!({"message":Message::user(format!("question-{index}"))}),
            )
            .await
            .unwrap();
        if index == 75 {
            retained = Some(event.id);
        }
        store
            .append_event(
                session.id,
                Some(turn),
                "agent.message_update",
                json!({"message":"transient"}),
            )
            .await
            .unwrap();
        store
            .append_event(session.id, Some(turn), "turn.completed", json!({}))
            .await
            .unwrap();
        store
            .append_event(
                session.id,
                None,
                "context.cache_state",
                json!({"assistantId":"a","cache":{"epoch":index}}),
            )
            .await
            .unwrap();
        store
            .append_event(
                session.id,
                None,
                "context.skill_snapshot",
                json!({"assistantId":"a","content":format!("skill-{index}")}),
            )
            .await
            .unwrap();
    }
    // A second actor's older state must survive the newer actor's snapshots.
    store
        .append_event(
            session.id,
            None,
            "context.cache_state",
            json!({"assistantId":"b","cache":{"epoch":1}}),
        )
        .await
        .unwrap();
    store
        .append_event(
            session.id,
            None,
            "context.subagent_notification",
            json!({"messageID":"mail-1","content":"worker finished"}),
        )
        .await
        .unwrap();
    store
        .append_event(
            session.id,
            None,
            "character.action.changed",
            json!({"characterId":"a","action":"wave"}),
        )
        .await
        .unwrap();
    for compacted in [false, true] {
        if compacted {
            store
                .append_event(
                    session.id,
                    None,
                    "context.compacted",
                    json!({"summary":"old summary","firstKeptEntryId":retained}),
                )
                .await
                .unwrap();
            store
                .append_event(
                    session.id,
                    None,
                    "context.compacted",
                    json!({"summary":"latest summary","firstKeptEntryId":retained}),
                )
                .await
                .unwrap();
            // Empty/tool-only messages must not displace the director's readable history.
            for _ in 0..25 {
                let turn = TurnId::new();
                store
                    .append_event(
                        session.id,
                        Some(turn),
                        "agent.message_end",
                        json!({"message":Message::Assistant(AssistantMessage::text(""))}),
                    )
                    .await
                    .unwrap();
                store
                    .append_event(session.id, Some(turn), "turn.completed", json!({}))
                    .await
                    .unwrap();
            }
        }
        let full = store.list_events(session.id, 0).await.unwrap();
        let filtered = store.list_context_events(session.id).await.unwrap();
        assert!(
            !filtered
                .iter()
                .any(|event| event.event_type == "agent.message_update")
        );
        assert_eq!(
            rebuild_context(&full, "system"),
            rebuild_context(&filtered, "system")
        );
        assert_eq!(
            director_conversation_context(&full, 12_000),
            director_conversation_context(&filtered, 12_000)
        );
        assert_eq!(
            latest_prompt_cache_states(&full),
            latest_prompt_cache_states(&filtered)
        );
        assert_eq!(
            latest_skill_snapshots(&full),
            latest_skill_snapshots(&filtered)
        );
        for kind in ["context.subagent_notification", "character.action.changed"] {
            assert_eq!(
                full.iter()
                    .filter(|e| e.event_type == kind)
                    .collect::<Vec<_>>(),
                filtered
                    .iter()
                    .filter(|e| e.event_type == kind)
                    .collect::<Vec<_>>()
            );
        }
        if compacted {
            assert!(filtered.len() < full.len() / 2);
        }
    }
}

#[tokio::test]
async fn manual_compaction_without_old_context_completes_as_a_noop() {
    let store = Store::in_memory().await.expect("store");
    let session = store
        .create_session("short context")
        .await
        .expect("session");
    let model = Arc::new(RecordingModel {
        requests: StdMutex::new(Vec::new()),
    });
    let runtime = SessionRuntime::new(
        store.clone(),
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            context_window: Some(128_000),
            ..ModelSpec::default()
        },
        model.clone(),
        ToolRegistry::new(),
        "system",
    );
    let mut notifications = runtime.subscribe();
    let input = runtime
        .compact(session.id, "preserve decisions".to_owned())
        .await
        .expect("queue compaction");
    wait_for_completion(&mut notifications).await;

    assert!(model.requests.lock().expect("requests").is_empty());
    let events = store.list_events(session.id, 0).await.expect("events");
    assert!(events.iter().any(|event| {
        event.turn_id == Some(input.input.turn_id)
            && event.event_type == "turn.completed"
            && event.payload["compacted"] == true
    }));
    assert!(!events.iter().any(|event| {
        event.turn_id == Some(input.input.turn_id)
            && matches!(
                event.event_type.as_str(),
                "context.compacted" | "context.compaction_failed"
            )
    }));
}

#[tokio::test]
async fn manual_compaction_failure_interrupts_the_input_without_a_false_completion() {
    let store = Store::in_memory().await.expect("store");
    let session = store
        .create_session("compaction failure")
        .await
        .expect("session");
    for index in 0..3 {
        let turn_id = TurnId::new();
        for message in [
            Message::user(format!("question-{index} {}", "old context ".repeat(200))),
            Message::Assistant(AssistantMessage::text(format!("answer-{index}"))),
        ] {
            store
                .append_event(
                    session.id,
                    Some(turn_id),
                    "agent.message_end",
                    json!({"message":message}),
                )
                .await
                .expect("seed message");
        }
        store
            .append_event(session.id, Some(turn_id), "turn.completed", json!({}))
            .await
            .expect("seed completed turn");
    }
    let runtime = SessionRuntime::new(
        store.clone(),
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            context_window: Some(128_000),
            ..ModelSpec::default()
        },
        Arc::new(CompactionFailureModel),
        ToolRegistry::new(),
        "system",
    );
    let mut notifications = runtime.subscribe();
    let input = runtime
        .compact(session.id, "keep project paths".to_owned())
        .await
        .expect("queue compaction");
    tokio::time::timeout(TEST_EVENT_TIMEOUT, async {
        loop {
            let event = notifications.recv().await.expect("runtime event");
            if event.turn_id == Some(input.input.turn_id) && event.event_type == "input.interrupted"
            {
                break;
            }
        }
    })
    .await
    .expect("interruption timeout");

    let events = store.list_events(session.id, 0).await.expect("events");
    assert!(events.iter().any(|event| {
        event.turn_id == Some(input.input.turn_id)
            && event.event_type == "context.compaction_failed"
            && event.payload["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("summary provider failed"))
    }));
    assert!(events.iter().any(|event| {
        event.turn_id == Some(input.input.turn_id) && event.event_type == "input.interrupted"
    }));
    assert!(!events.iter().any(|event| {
        event.turn_id == Some(input.input.turn_id) && event.event_type == "turn.completed"
    }));
}

#[tokio::test]
async fn tool_loop_context_compacts_and_continues_the_same_run() {
    let store = Store::in_memory().await.expect("store");
    let session = store.create_session("loop").await.expect("session");
    let model = Arc::new(LoopCompactionModel {
        requests: StdMutex::new(Vec::new()),
    });
    let model_spec = ModelSpec {
        id: "test".to_owned(),
        provider: "test".to_owned(),
        context_window: Some(512),
        max_tokens: Some(128),
        ..ModelSpec::default()
    };
    let inner = RuntimeInner {
        store: store.clone(),
        model_spec: model_spec.clone(),
        model: model.clone(),
        tools: ToolRegistry::new(),
        hooks: Arc::new(NoopToolHooks),
        system_prompt: Arc::new(RwLock::new("system".to_owned())),
        blobs: None,
        actors: Mutex::new(HashMap::new()),
    };
    let turn_id = TurnId::new();
    let hook = RuntimeLoopHooks::new(
        &inner,
        &inner.tools,
        model_spec,
        session.id,
        turn_id,
        "runtime-default".to_owned(),
    );
    let mut source_messages = Vec::new();
    for index in 0..20 {
        if index % 2 == 0 {
            source_messages.push(Message::user(format!(
                "user-{index}: {}",
                "long context ".repeat(20)
            )));
        } else {
            source_messages.push(Message::Assistant(AssistantMessage::text(format!(
                "assistant-{index}: {}",
                "completed work ".repeat(20)
            ))));
        }
    }
    let first = hook
        .prepare_model_context(
            AgentContext {
                system_prompt: "system".to_owned(),
                messages: source_messages.clone(),
                metadata: json!({}),
            },
            CancellationToken::new(),
        )
        .await
        .expect("first loop compaction");
    assert!(matches!(
        first.messages.first(),
        Some(Message::CompactionSummary { .. })
    ));
    assert!(first.messages.len() < source_messages.len());

    source_messages.push(
            serde_json::from_value(json!({
                "role":"assistant",
                "content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"README.md"}}],
                "stopReason":"tool_calls",
                "timestamp":1,
            }))
            .expect("tool call"),
        );
    source_messages.push(
        serde_json::from_value(json!({
            "role":"toolResult",
            "toolCallId":"call-1",
            "toolName":"read",
            "content":[{"type":"text","text":"fresh tool result"}],
            "details":{},
            "success":true,
            "isError":false,
            "timestamp":2,
        }))
        .expect("tool result"),
    );
    let continued = hook
        .prepare_model_context(
            AgentContext {
                system_prompt: "system".to_owned(),
                messages: source_messages,
                metadata: json!({}),
            },
            CancellationToken::new(),
        )
        .await
        .expect("continue after compaction");
    assert!(matches!(
        continued.messages.first(),
        Some(Message::CompactionSummary { .. })
    ));
    assert!(
        continued
            .messages
            .iter()
            .any(|message| matches!(message, Message::ToolResult(result)
            if result.tool_call_id == "call-1"))
    );
    assert_eq!(model.requests.lock().expect("requests").len(), 1);
    let events = store.list_events(session.id, 0).await.expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "context.loop_compacted")
            .count(),
        1,
    );
    let compacted = events
        .iter()
        .find(|event| event.event_type == "context.loop_compacted")
        .expect("compaction event");
    assert!(
        compacted.payload["tokensAfter"]
            .as_u64()
            .expect("tokens after")
            <= compacted.payload["promptBudget"]
                .as_u64()
                .expect("prompt budget")
    );
}
