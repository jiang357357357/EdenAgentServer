use super::*;

#[test]
fn payload_preserves_messages_images_and_tools() {
    let request = request(vec![Message::User {
        content: UserContent::Blocks(vec![
            ContentBlock::Text {
                text: "inspect".to_owned(),
            },
            ContentBlock::Image {
                data: "AA==".to_owned(),
                mime_type: "image/png".to_owned(),
                source: None,
            },
        ]),
        timestamp: 1,
        extra: Map::new(),
    }]);
    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert_eq!(payload["messages"][0]["role"], "system");
    assert_eq!(payload["messages"][1]["content"][1]["type"], "image_url");
    assert_eq!(payload["tools"][0]["function"]["name"], "read");
}

#[test]
fn request_budget_rejects_prompt_that_cannot_leave_output_reserve() {
    let mut request = request(vec![Message::user("x".repeat(2_000))]);
    request.model.context_window = Some(100);
    request.model.max_tokens = Some(20);
    let error = validate_request_budget(&request).expect_err("oversized prompt must fail closed");
    assert_eq!(error.code, "context_window_exceeded");
    assert!(error.message.contains("80 are available"));
}

#[test]
fn model_option_uses_core_configured_context_window() {
    let option = model_option(
        &json!({
            "id":1,
            "ai_model":"test-model",
            "ai_name":"test",
            "vendor":"test",
            "status":"active",
            "default_params":{"context_window":256000},
        }),
        None,
        &json!({}),
    );
    assert_eq!(option["contextWindow"], 256_000);
}

#[test]
fn chat_payload_uses_structured_speaker_names_and_cleans_legacy_prefixes() {
    let mut request = request(vec![
        assistant_message_with_speaker("[阿罗娜] 老师好。", "3", "阿罗娜助手", "阿罗娜"),
        assistant_message_with_speaker("[普拉娜] 已经完成交接。", "4", "普拉娜助手", "普拉娜"),
    ]);
    request.metadata = json!({
        "primaryAssistantId":"3",
        "currentSpeakerNames":["阿罗娜", "阿罗娜助手"],
    });

    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    let messages = payload["messages"].as_array().expect("messages");
    assert!(
        messages[1]["content"]
            .as_str()
            .expect("mapping")
            .contains("assistant_4 = 普拉娜")
    );
    assert_eq!(messages[2]["content"], "老师好。");
    assert!(messages[2].get("name").is_none());
    assert_eq!(messages[3]["content"], "已经完成交接。");
    assert_eq!(messages[3]["name"], "assistant_4");
}

#[test]
fn leading_speaker_prefix_filter_handles_cross_chunk_output_without_eating_natural_text() {
    let names = vec!["阿罗娜".to_owned(), "阿罗娜助手".to_owned()];
    let mut filter = LeadingSpeakerPrefixFilter::new(&names);
    let output = ["[", "阿罗", "娜] ", " 老师好。"]
        .into_iter()
        .map(|chunk| filter.push(chunk))
        .collect::<String>();
    assert_eq!(output, "老师好。");

    let mut natural = LeadingSpeakerPrefixFilter::new(&names);
    let mut output = ["阿罗", "娜今天也在。"]
        .into_iter()
        .map(|chunk| natural.push(chunk))
        .collect::<String>();
    output.push_str(&natural.finish());
    assert_eq!(output, "阿罗娜今天也在。");
}

#[test]
fn supported_chat_payload_forwards_the_session_cache_key() {
    let mut request = request(Vec::new());
    request.model.provider = "opencode_go".to_owned();
    request.metadata = json!({"promptCacheKey":"session-cache-key"});
    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert_eq!(payload["prompt_cache_key"], "session-cache-key");
    assert_eq!(payload["stream_options"]["include_usage"], true);
}

#[test]
fn usage_normalization_handles_both_cached_token_conventions() {
    assert_eq!(
        normalized_openai_usage(&json!({
            "prompt_tokens":1309,
            "completion_tokens":723,
            "prompt_tokens_details":{"cached_tokens":5143},
        })),
        json!({
            "input":6452,"output":723,"cacheRead":5143,"cacheMiss":1309,
            "cacheWrite":0,"totalTokens":7175,
            "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},
        }),
    );
    assert_eq!(
        normalized_openai_usage(&json!({
            "prompt_tokens":100,
            "completion_tokens":10,
            "prompt_tokens_details":{"cached_tokens":40},
        }))["totalTokens"],
        110,
    );
}

#[test]
fn responses_payload_preserves_cache_reasoning_tools_and_tool_replay() {
    let mut request = request(vec![
        Message::Assistant(AssistantMessage {
            content: vec![ContentBlock::ToolCall {
                id: "call_1".to_owned(),
                name: "read".to_owned(),
                arguments: json!({"path":"a.txt"}),
                provider_item_id: Some("fc_1".to_owned()),
            }],
            stop_reason: "tool_calls".to_owned(),
            ..AssistantMessage::text("")
        }),
        serde_json::from_value(json!({
            "role":"toolResult",
            "toolCallId":"call_1",
            "toolName":"read",
            "content":[{"type":"text","text":"contents"}],
            "details":{},"success":true,"isError":false,"timestamp":1,
        }))
        .expect("tool result"),
    ]);
    request.model.api = "openai-responses".to_owned();
    request.model.provider = "openai".to_owned();
    request
        .model
        .extra
        .insert("reasoning_effort".to_owned(), json!("medium"));
    request.metadata = json!({"promptCacheKey":"session-cache-key"});
    let payload = responses_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert_eq!(payload["prompt_cache_key"], "session-cache-key");
    assert_eq!(
        payload["reasoning"],
        json!({"effort":"medium","summary":"detailed"})
    );
    assert_eq!(payload["tools"][0]["name"], "read");
    assert_eq!(payload["input"][0]["id"], "fc_1");
    assert_eq!(payload["input"][0]["call_id"], "call_1");
    assert_eq!(
        payload["input"][1],
        json!({"type":"function_call_output","call_id":"call_1","output":"contents"}),
    );
}

#[test]
fn chat_payload_keeps_compaction_and_skill_snapshot_context() {
    let mut request = request(vec![
        serde_json::from_value(json!({
            "role":"compactionSummary","summary":"checkpoint","timestamp":1,
        }))
        .expect("compaction"),
        serde_json::from_value(json!({
            "role":"custom","customType":"skillSnapshot","content":"stable skill","timestamp":2,
        }))
        .expect("snapshot"),
    ]);
    request.tools.clear();
    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert!(
        payload["messages"][1]["content"]
            .as_str()
            .expect("summary")
            .contains("checkpoint")
    );
    assert_eq!(payload["messages"][2]["content"], "stable skill");
}

#[test]
fn payload_uses_safe_core_generation_defaults() {
    let mut request = request(Vec::new());
    request.model.provider = "openai".to_owned();
    request.model.max_tokens = Some(4096);
    request.model.extra = JsonMap::from_iter([
        ("temperature".to_owned(), json!(0.7)),
        ("top_p".to_owned(), json!(0.9)),
        ("thinking_enabled".to_owned(), json!(true)),
        ("reasoning_effort".to_owned(), json!("medium")),
    ]);
    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert_eq!(payload["max_tokens"], 4096);
    assert_eq!(payload["temperature"], 0.7);
    assert_eq!(payload["top_p"], 0.9);
    assert_eq!(payload["reasoning_effort"], "medium");
    assert!(payload.get("thinking_enabled").is_none());
}

#[test]
fn deepseek_payload_uses_the_strict_common_tool_contract_without_openai_extensions() {
    let mut request = request(Vec::new());
    request.model.provider = "deepseek".to_owned();
    request
        .model
        .extra
        .insert("reasoning_effort".to_owned(), json!("low"));
    request.metadata = json!({"promptCacheKey":"not-supported"});
    let payload = chat_payload(&request, ProviderCapabilities::for_model(&request.model));
    assert_eq!(
        payload["tools"][0]["function"]["parameters"],
        json!({
            "type":"object",
            "properties":{},
            "additionalProperties":false,
        })
    );
    assert!(payload.get("prompt_cache_key").is_none());
    assert!(payload.get("reasoning_effort").is_none());
    assert_eq!(payload["stream_options"]["include_usage"], true);
}
