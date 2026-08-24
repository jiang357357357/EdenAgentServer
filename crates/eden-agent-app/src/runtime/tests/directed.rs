use super::*;

#[tokio::test]
async fn multi_participant_turn_persists_one_user_message_and_ordered_speakers() {
    let store = Store::in_memory().await.expect("store");
    let session = store
            .create_session_with_participants(
                "companions",
                vec![
                    json!({"assistantId":"1","assistantName":"甲","characterId":"11","characterName":"甲","profile":{"api_key":"must-not-leak"}}),
                    json!({"assistantId":"2","assistantName":"乙","characterId":"22","characterName":"乙"}),
                ],
            )
            .await
            .expect("session");
    let model = Arc::new(DirectorModel {
        requests: StdMutex::new(Vec::new()),
    });
    let runtime = SessionRuntime::new(
        store.clone(),
        ModelSpec {
            id: "test".to_owned(),
            provider: "test".to_owned(),
            ..ModelSpec::default()
        },
        model,
        ToolRegistry::new(),
        "system",
    );
    let mut notifications = runtime.subscribe();
    runtime
        .submit_turn(session.id, "你们一起聊聊".to_owned(), json!([]))
        .await
        .expect("turn");
    wait_for_completion(&mut notifications).await;

    let events = store.list_events(session.id, 0).await.expect("events");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "companion.speaker.started")
            .count(),
        2
    );
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "companion.director.completed")
    );
    let messages = events
        .iter()
        .filter(|event| event.event_type == "agent.message_end")
        .filter_map(|event| event.payload.get("message"))
        .collect::<Vec<_>>();
    let starts = events
        .iter()
        .filter(|event| event.event_type == "agent.message_start")
        .filter(|event| event.payload["message"]["role"] != "toolResult")
        .collect::<Vec<_>>();
    let ends = events
        .iter()
        .filter(|event| event.event_type == "agent.message_end")
        .filter(|event| event.payload["message"]["role"] != "toolResult")
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), ends.len());
    for (start, end) in starts.iter().zip(&ends) {
        assert_eq!(end.payload["messageId"], start.id.to_string());
    }
    assert_eq!(
        messages
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .count(),
        1
    );
    let assistants = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .collect::<Vec<_>>();
    assert_eq!(assistants.len(), 2);
    assert_eq!(assistants[0]["speaker"]["assistantID"], "1");
    assert_eq!(assistants[1]["speaker"]["assistantID"], "2");
    assert_eq!(assistants[1]["orchestration"]["replyToBeat"], 0);
    assert!(
        !events
            .iter()
            .any(|event| event.payload.to_string().contains("must-not-leak"))
    );
}

#[tokio::test]
async fn assistant_handoff_prompt_is_hidden_and_excluded_from_future_context() {
    let message = build_user_message(
        None,
        &json!({"internalHandoff":true,"attachments":[]}),
        "internal handoff",
    )
    .await
    .expect("handoff message");
    let message = serde_json::to_value(message).expect("message JSON");
    assert_eq!(message["display"], false);
    assert_eq!(message["transient"], true);
    assert_eq!(message["internalHandoff"], true);

    let session_id = SessionId::new();
    let turn_id = TurnId::new();
    let events = vec![
        EventRecord {
            id: uuid::Uuid::now_v7(),
            session_id,
            seq: 1,
            turn_id: Some(turn_id),
            event_type: "agent.message_end".to_owned(),
            payload: json!({"message":message}),
            created_at: 1,
        },
        EventRecord {
            id: uuid::Uuid::now_v7(),
            session_id,
            seq: 2,
            turn_id: Some(turn_id),
            event_type: "turn.completed".to_owned(),
            payload: json!({}),
            created_at: 2,
        },
    ];
    assert!(conversation_entries(&events).is_empty());
}
