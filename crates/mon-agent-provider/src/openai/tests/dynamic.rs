use super::*;

#[tokio::test]
async fn dynamic_core_configuration_never_exposes_api_key() {
    let runtime = DynamicModelProvider::from_env();
    let info = runtime
        .configure_core_entity(
            &json!({
                "id": 7,
                "ai_name": "Core model",
                "ai_model": "deepseek-v4-flash",
                "vendor": "opencode_go",
                "api_endpoint": "https://example.invalid/v1",
                "api_key": "top-secret",
                "status": "active",
                "default_params": {"temperature": 0.6}
            }),
            "Core model",
        )
        .await
        .expect("configure Core model");
    let encoded = info.to_string();
    assert!(!encoded.contains("top-secret"));
    assert_eq!(info["aiEntityId"], 7);
    assert_eq!(runtime.model_spec().await.id, "deepseek-v4-flash");
}

#[tokio::test]
async fn session_model_bindings_are_isolated() {
    let runtime = DynamicModelProvider::from_env();
    for (session, id, model) in [("session-a", 7, "model-a"), ("session-b", 8, "model-b")] {
        runtime
            .configure_core_entity_for(
                Some(session),
                &json!({
                    "id": id,
                    "ai_name": model,
                    "ai_model": model,
                    "vendor": "openai",
                    "api_endpoint": "https://example.invalid/v1",
                    "api_key": format!("secret-{id}"),
                    "status": "active",
                    "default_params": {"context_window": 64000 + id}
                }),
                model,
            )
            .await
            .expect("configure session model");
    }

    assert_eq!(
        runtime.model_spec_for(Some("session-a")).await.id,
        "model-a"
    );
    assert_eq!(
        runtime.model_spec_for(Some("session-b")).await.id,
        "model-b"
    );
    assert_eq!(
        runtime.runtime_info_for(Some("session-a")).await["aiEntityId"],
        7
    );
    assert_eq!(
        runtime.runtime_info_for(Some("session-b")).await["aiEntityId"],
        8
    );
    let availability = runtime.availability().await;
    assert_eq!(availability.available_session_bindings, 2);
    assert_eq!(availability.unavailable_session_bindings, 0);
    assert!(
        !runtime
            .runtime_info_for(Some("session-a"))
            .await
            .to_string()
            .contains("secret-7")
    );
}

#[tokio::test]
async fn session_model_snapshot_restores_all_handoff_scoped_bindings() {
    let runtime = DynamicModelProvider::from_env();
    let entity = |id: i64, model: &str| {
        json!({
            "id":id,
            "ai_name":model,
            "ai_model":model,
            "vendor":"openai",
            "api_endpoint":"https://example.invalid/v1",
            "api_key":format!("secret-{id}"),
            "status":"active",
            "is_multimodal":false,
        })
    };
    runtime
        .configure_core_entity_for(Some("session-a"), &entity(1, "old-main"), "old-main")
        .await
        .expect("old session model");
    runtime
        .configure_core_entity_for_actor(
            "session-a",
            "old-assistant",
            &entity(2, "old-actor"),
            "old-actor",
        )
        .await
        .expect("old actor model");
    let snapshot = runtime.snapshot_session("session-a").await;
    runtime
        .configure_core_entity_for(Some("session-a"), &entity(3, "new-main"), "new-main")
        .await
        .expect("new session model");
    runtime
        .configure_core_entity_for_actor(
            "session-a",
            "new-assistant",
            &entity(4, "new-actor"),
            "new-actor",
        )
        .await
        .expect("new actor model");

    runtime.restore_session(snapshot).await;

    assert_eq!(
        runtime.model_spec_for(Some("session-a")).await.id,
        "old-main"
    );
    assert_eq!(
        runtime
            .model_spec_for_actor(Some("session-a"), Some("old-assistant"))
            .await
            .expect("restored old actor")
            .id,
        "old-actor"
    );
    assert_eq!(
        runtime
            .model_spec_for_actor(Some("session-a"), Some("new-assistant"))
            .await
            .expect("session fallback for removed target actor")
            .id,
        "old-main"
    );
}

#[tokio::test]
async fn actor_model_bindings_are_isolated_within_one_session() {
    let runtime = DynamicModelProvider::from_env();
    for (assistant, id, model) in [("1", 11, "actor-a"), ("2", 12, "actor-b")] {
        runtime
            .configure_core_entity_for_actor(
                "session-a",
                assistant,
                &json!({
                    "id":id,
                    "ai_name":model,
                    "ai_model":model,
                    "vendor":"openai",
                    "api_endpoint":"https://example.invalid/v1",
                    "api_key":format!("secret-{id}"),
                    "status":"active",
                    "is_multimodal":false
                }),
                model,
            )
            .await
            .expect("configure actor");
    }
    assert_eq!(
        runtime
            .model_spec_for_actor(Some("session-a"), Some("1"))
            .await
            .expect("actor a")
            .id,
        "actor-a"
    );
    assert_eq!(
        runtime
            .model_spec_for_actor(Some("session-a"), Some("2"))
            .await
            .expect("actor b")
            .id,
        "actor-b"
    );
    let availability = runtime.availability().await;
    assert_eq!(availability.available_actor_bindings, 2);
    assert_eq!(availability.unavailable_actor_bindings, 0);
    assert!(availability.is_ready());
}

#[tokio::test]
async fn text_only_session_uses_bound_vision_model_for_images() {
    let runtime = DynamicModelProvider::from_env();
    runtime
        .configure_core_entity_for(
            Some("session-a"),
            &json!({
                "id": 7,
                "ai_name": "text model",
                "ai_model": "text-only",
                "vendor": "openai",
                "api_endpoint": "https://example.invalid/v1",
                "api_key": "secret-main",
                "status": "active",
                "is_multimodal": false
            }),
            "text model",
        )
        .await
        .expect("configure text model");
    let mut vision_spec = ModelSpec {
        id: "vision-model".to_owned(),
        provider: "test".to_owned(),
        ..ModelSpec::default()
    };
    vision_spec
        .extra
        .insert("is_multimodal".to_owned(), Value::Bool(true));
    runtime.session_vision_bindings.write().await.insert(
        "session-a".to_owned(),
        ModelBinding {
            spec: vision_spec,
            adapter: Some(Arc::new(FakeVisionProvider)),
            info: json!({"aiEntityId": 8}),
            error: None,
        },
    );

    let prepared = runtime
        .prepare_user_message(
            Some("session-a"),
            Message::User {
                content: UserContent::Blocks(vec![
                    ContentBlock::Text {
                        text: "看看问题".to_owned(),
                    },
                    ContentBlock::Image {
                        data: "AA==".to_owned(),
                        mime_type: "image/png".to_owned(),
                        source: None,
                    },
                ]),
                timestamp: 1,
                extra: Map::new(),
            },
            CancellationToken::new(),
        )
        .await
        .expect("prepare image message");
    let Message::User {
        content: UserContent::Blocks(blocks),
        ..
    } = prepared
    else {
        panic!("expected user blocks");
    };
    assert!(
        !blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
    );
    assert!(blocks.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("自动视觉分析结果") && text.contains("错误日志窗口"))
    }));
}

#[tokio::test]
async fn multimodal_session_keeps_original_images() {
    let runtime = DynamicModelProvider::from_env();
    runtime
        .configure_core_entity_for(
            Some("session-a"),
            &json!({
                "id": 7,
                "ai_name": "vision model",
                "ai_model": "multimodal",
                "vendor": "openai",
                "api_endpoint": "https://example.invalid/v1",
                "api_key": "secret-main",
                "status": "active",
                "is_multimodal": true
            }),
            "vision model",
        )
        .await
        .expect("configure multimodal model");
    let prepared = runtime
        .prepare_user_message(
            Some("session-a"),
            Message::User {
                content: UserContent::Blocks(vec![ContentBlock::Image {
                    data: "AA==".to_owned(),
                    mime_type: "image/png".to_owned(),
                    source: None,
                }]),
                timestamp: 1,
                extra: Map::new(),
            },
            CancellationToken::new(),
        )
        .await
        .expect("prepare image message");
    assert!(matches!(
        prepared,
        Message::User { content: UserContent::Blocks(blocks), .. }
            if matches!(blocks.as_slice(), [ContentBlock::Image { .. }])
    ));
}
