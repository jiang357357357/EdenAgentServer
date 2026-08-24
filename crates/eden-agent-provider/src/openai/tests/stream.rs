use super::*;

#[test]
fn response_parses_reasoning_text_and_tool_calls() {
    let output = parse_chat_response(
        &request(Vec::new()).model,
        json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "reasoning_content": "check first",
                    "content": "working",
                    "tool_calls": [{
                        "id": "call_1",
                        "function": {"name": "read", "arguments": "{\"path\":\"README.md\"}"}
                    }]
                }
            }],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2}
        }),
    )
    .expect("response");
    assert!(matches!(output.content[0], ContentBlock::Thinking { .. }));
    assert!(matches!(output.content[2], ContentBlock::ToolCall { .. }));
    assert_eq!(output.stop_reason, "tool_calls");
}

#[test]
fn stream_accumulator_reassembles_text_reasoning_and_tool_arguments() {
    let model = request(Vec::new()).model;
    let mut stream = StreamAccumulator::default();
    stream.apply_chunk(&json!({"choices":[{"delta":{"reasoning_content":"check "}}]}));
    stream.apply_chunk(
        &json!({"choices":[{"delta":{"content":"done","tool_calls":[{
            "index":0,"id":"call_1","function":{"name":"read","arguments":"{\"path\":"}
        }]}}]}),
    );
    stream.apply_chunk(&json!({"choices":[{"delta":{"tool_calls":[{
            "index":0,"function":{"arguments":"\"README.md\"}"}
        }]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}));
    let message = stream.message(&model);
    assert!(
        matches!(&message.content[0], ContentBlock::Thinking { thinking, .. } if thinking == "check ")
    );
    assert!(matches!(&message.content[1], ContentBlock::Text { text } if text == "done"));
    assert!(
        matches!(&message.content[2], ContentBlock::ToolCall { name, arguments, .. } if name == "read" && arguments["path"] == "README.md")
    );
    assert_eq!(message.stop_reason, "tool_calls");
    assert_eq!(message.usage.as_ref().expect("usage")["totalTokens"], 9);
}

#[tokio::test]
async fn incomplete_stream_retracts_partial_content_and_retries() {
    let (provider, server) = test_stream_provider(
            vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"final\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            ],
            1,
        )
        .await;
    let (events, mut receiver) = event_channel(32);
    let output = provider
        .generate(request(Vec::new()), events, CancellationToken::new())
        .await
        .expect("retry should complete");
    server.await.expect("test server");

    assert!(matches!(&output.message.content[0], ContentBlock::Text { text } if text == "final"));
    let mut observed = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        observed.push(event);
    }
    let reset_index = observed
        .iter()
        .position(|event| {
            matches!(event, AgentEvent::StreamReset { message, .. }
                if matches!(&message.content[0], ContentBlock::Text { text } if text.is_empty()))
        })
        .expect("partial stream should be reset");
    let retry_index = observed
        .iter()
        .position(|event| matches!(event, AgentEvent::ModelRetry { attempt: 2, .. }))
        .expect("retry event");
    assert!(reset_index < retry_index);
    assert_eq!(
        observed
            .iter()
            .filter(|event| matches!(event, AgentEvent::StreamReset { .. }))
            .count(),
        1,
    );
}

#[tokio::test]
async fn chat_stream_filters_current_speaker_prefix_before_events_and_output() {
    let (provider, server) = test_stream_provider(
        vec![concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"[阿罗\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"娜] \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" 老师好。\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        )],
        0,
    )
    .await;
    let (events, mut receiver) = event_channel(32);
    let mut model_request = request(Vec::new());
    model_request.metadata = json!({"currentSpeakerNames":["阿罗娜"]});

    let output = provider
        .generate(model_request, events, CancellationToken::new())
        .await
        .expect("stream should complete");
    server.await.expect("test server");

    assert!(
        matches!(&output.message.content[0], ContentBlock::Text { text } if text == "老师好。")
    );
    let mut streamed = String::new();
    while let Ok(event) = receiver.try_recv() {
        if let AgentEvent::MessageUpdate { delta, message, .. } = event {
            streamed.push_str(&delta);
            assert!(!text_content(&message.content).starts_with("[阿罗娜]"));
        }
    }
    assert_eq!(streamed, "老师好。");
}

#[tokio::test]
async fn incomplete_stream_is_not_retried_after_a_tool_call_begins() {
    let (provider, server) = test_stream_provider(
            vec!["data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write\",\"arguments\":\"{}\"}}]}}]}\n\n"],
            1,
        )
        .await;
    let (events, mut receiver) = event_channel(32);
    let error = provider
        .generate(request(Vec::new()), events, CancellationToken::new())
        .await
        .expect_err("tool-call stream must not be replayed");
    server.await.expect("test server");
    assert_eq!(error.code, "provider_stream_incomplete");
    while let Ok(event) = receiver.try_recv() {
        assert!(!matches!(event, AgentEvent::ModelRetry { .. }));
        assert!(!matches!(event, AgentEvent::StreamReset { .. }));
    }
}

#[tokio::test]
async fn luna_uses_responses_stream_for_reasoning_text_and_usage() {
    let (provider, server) = test_stream_provider(
            vec![concat!(
                "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"inspect\"}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":5,\"input_tokens_details\":{\"cached_tokens\":2}}}}\n\n",
                "data: [DONE]\n\n",
            )],
            0,
        )
        .await;
    let mut model_request = request(Vec::new());
    model_request.model.id = "gpt-5.6-luna".to_owned();
    model_request.model.provider = "opencode-go".to_owned();
    let (events, _receiver) = event_channel(32);
    let output = provider
        .generate(model_request, events, CancellationToken::new())
        .await
        .expect("responses output");
    server.await.expect("test server");
    assert_eq!(output.message.api, "openai-responses");
    assert!(
        matches!(&output.message.content[0], ContentBlock::Thinking { thinking, .. } if thinking == "inspect")
    );
    assert!(matches!(&output.message.content[1], ContentBlock::Text { text } if text == "done"));
    assert_eq!(
        output.message.usage.as_ref().expect("usage")["totalTokens"],
        12
    );
}

#[tokio::test]
async fn responses_native_web_search_preserves_unique_missing_citations() {
    let (provider, server) = test_stream_provider(
            vec![concat!(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"结论包含 https://example.com/already\"}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"annotations\":[{\"type\":\"url_citation\",\"title\":\"已有\",\"url\":\"https://example.com/already\"},{\"type\":\"url_citation\",\"title\":\"新来源\",\"url\":\"https://example.com/new\"},{\"type\":\"url_citation\",\"title\":\"重复来源\",\"url\":\"https://example.com/new\"}]}]}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
                "data: [DONE]\n\n",
            )],
            0,
        )
        .await;
    let mut model_request = request(Vec::new());
    model_request.model.api = "openai-responses".to_owned();
    let (events, _receiver) = event_channel(32);
    let output = provider
        .generate(model_request, events, CancellationToken::new())
        .await
        .expect("responses output");
    server.await.expect("test server");

    let ContentBlock::Text { text } = &output.message.content[0] else {
        panic!("expected text response");
    };
    assert!(text.contains("结论包含 https://example.com/already"));
    assert!(!text.contains("[已有](https://example.com/already)"));
    assert_eq!(text.matches("https://example.com/new").count(), 1);
    assert!(text.ends_with("来源：\n- [新来源](https://example.com/new)"));
}

#[tokio::test]
async fn responses_stream_retracts_partial_output_before_retry() {
    let (provider, server) = test_stream_provider(
            vec![
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
                concat!(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"recovered\"}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
                    "data: [DONE]\n\n",
                ),
            ],
            1,
        )
        .await;
    let mut model_request = request(Vec::new());
    model_request.model.api = "openai-responses".to_owned();
    let (events, mut receiver) = event_channel(32);
    let output = provider
        .generate(model_request, events, CancellationToken::new())
        .await
        .expect("retry should recover");
    server.await.expect("test server");
    assert!(
        matches!(&output.message.content[0], ContentBlock::Text { text } if text == "recovered")
    );
    let mut reset_seen = false;
    let mut retry_seen = false;
    while let Ok(event) = receiver.try_recv() {
        reset_seen |= matches!(event, AgentEvent::StreamReset { .. });
        retry_seen |= matches!(event, AgentEvent::ModelRetry { attempt: 2, .. });
    }
    assert!(reset_seen && retry_seen);
}
