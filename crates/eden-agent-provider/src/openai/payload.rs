use eden_agent_core::{ContentBlock, Message, ModelRequest, UserContent};
use serde_json::{Value, json};

use super::capabilities::ProviderCapabilities;
use super::messages::{append_openai_message, text_content};
use super::speaker::{
    assistant_speaker, historical_speaker_instruction, strip_redundant_speaker_prefix,
};

pub(super) fn chat_payload(request: &ModelRequest, capabilities: ProviderCapabilities) -> Value {
    let mut messages = Vec::new();
    if !request.system_prompt.trim().is_empty() {
        messages.push(json!({"role": "system", "content": request.system_prompt}));
    }
    let active_assistant_id = request
        .metadata
        .get("primaryAssistantId")
        .and_then(Value::as_str);
    if let Some(instruction) = historical_speaker_instruction(request, active_assistant_id) {
        messages.push(json!({"role": "system", "content": instruction}));
    }
    for message in &request.messages {
        append_openai_message(&mut messages, message, active_assistant_id);
    }
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            })
        })
        .collect::<Vec<_>>();
    let mut payload = json!({
        "model": request.model.id,
        "messages": messages,
        "stream": true,
    });
    if capabilities.stream_usage {
        payload["stream_options"] = json!({"include_usage": true});
    }
    if capabilities.prompt_cache_key
        && let Some(cache_key) = prompt_cache_key(request)
    {
        payload["prompt_cache_key"] = Value::String(cache_key.to_owned());
    }
    if !tools.is_empty() {
        payload["tools"] = Value::Array(tools);
        payload["tool_choice"] = Value::String("auto".to_owned());
    }
    if let Some(max_tokens) = request.model.max_tokens {
        payload["max_tokens"] = Value::from(max_tokens);
    }
    for key in ["temperature", "top_p"] {
        if let Some(value) = request.model.extra.get(key) {
            payload[key] = value.clone();
        }
    }
    if capabilities.reasoning_effort
        && request
            .model
            .extra
            .get("thinking_enabled")
            .and_then(Value::as_bool)
            != Some(false)
    {
        if let Some(value) = request.model.extra.get("reasoning_effort") {
            payload["reasoning_effort"] = value.clone();
        }
    }
    payload
}

pub(super) fn responses_payload(
    request: &ModelRequest,
    capabilities: ProviderCapabilities,
) -> Value {
    let native_web_search = request
        .model
        .extra
        .get("nativeWebSearch")
        .or_else(|| request.model.extra.get("native_web_search"))
        .and_then(Value::as_bool)
        == Some(true);
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            if native_web_search && tool.name == "web" {
                json!({"type":"web_search"})
            } else {
                json!({
                    "type":"function",
                    "name":tool.name,
                    "description":tool.description,
                    "parameters":tool.parameters,
                })
            }
        })
        .collect::<Vec<_>>();
    let mut payload = json!({
        "model":request.model.id,
        "input":responses_input(&request.messages),
        "stream":true,
    });
    if !request.system_prompt.trim().is_empty() {
        payload["instructions"] = Value::String(request.system_prompt.clone());
    }
    if capabilities.prompt_cache_key
        && let Some(cache_key) = prompt_cache_key(request)
    {
        payload["prompt_cache_key"] = Value::String(cache_key.to_owned());
    }
    if let Some(max_tokens) = request.model.max_tokens {
        payload["max_output_tokens"] = Value::from(max_tokens);
    }
    if capabilities.reasoning_effort
        && let Some(effort) = request
            .model
            .extra
            .get("reasoning_effort")
            .or_else(|| request.model.extra.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|effort| *effort != "off")
    {
        payload["reasoning"] = json!({"effort":effort,"summary":"detailed"});
    }
    if !tools.is_empty() {
        payload["tools"] = Value::Array(tools);
        payload["tool_choice"] = Value::String("auto".to_owned());
    }
    payload
}

pub(super) fn responses_input(messages: &[Message]) -> Vec<Value> {
    let mut items = Vec::new();
    for message in messages {
        match message {
            Message::User { content, .. } => {
                items.push(json!({"role":"user","content":responses_user_content(content)}));
            }
            Message::Assistant(message) if !message.is_terminal_failure() => {
                let mut text = text_content(&message.content);
                if let Some((_, names)) = assistant_speaker(message) {
                    text = strip_redundant_speaker_prefix(&text, &names);
                }
                if !text.trim().is_empty() {
                    items.push(json!({"role":"assistant","content":text}));
                }
                for block in &message.content {
                    let ContentBlock::ToolCall {
                        id,
                        name,
                        arguments,
                        provider_item_id,
                    } = block
                    else {
                        continue;
                    };
                    let mut item = json!({
                        "type":"function_call",
                        "call_id":id,
                        "name":name,
                        "arguments":arguments.to_string(),
                    });
                    if let Some(provider_item_id) = provider_item_id {
                        item["id"] = Value::String(provider_item_id.clone());
                    }
                    items.push(item);
                }
            }
            Message::ToolResult(result) => {
                let output = result.structured_content.as_ref().map_or_else(
                    || text_content(&result.content),
                    |structured| {
                        let text = text_content(&result.content);
                        if text.is_empty() {
                            structured.to_string()
                        } else {
                            format!("{text}\n\n<structured_output>{structured}</structured_output>")
                        }
                    },
                );
                let images = result
                    .content
                    .iter()
                    .chain(result.external_context.iter())
                    .filter(|block| matches!(block, ContentBlock::Image { .. }))
                    .cloned()
                    .collect::<Vec<_>>();
                items.push(json!({
                    "type":"function_call_output",
                    "call_id":result.tool_call_id,
                    "output":if output.is_empty() && !images.is_empty() { "The tool returned an image." } else { &output },
                }));
                if !images.is_empty() {
                    let mut content = vec![json!({
                        "type":"input_text",
                        "text":format!("The following image was returned by {}. Analyze it directly.", result.tool_name),
                    })];
                    content.extend(images.iter().filter_map(response_image_content));
                    items.push(json!({"role":"user","content":content}));
                }
            }
            Message::CompactionSummary { data } => {
                let summary = data
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                items.push(json!({
                    "role":"user",
                    "content":format!("The conversation history before this point was compacted into the following summary:\n\n<summary>\n{summary}\n</summary>"),
                }));
            }
            Message::BranchSummary { data } => {
                if let Some(summary) = data.get("summary").and_then(Value::as_str) {
                    items.push(json!({"role":"user","content":format!("<branch_summary>\n{summary}\n</branch_summary>")}));
                }
            }
            Message::Custom { data } => {
                if let Some(content) = data
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    items.push(json!({"role":"user","content":content}));
                }
            }
            Message::BashExecution { data } => {
                items.push(json!({
                    "role":"user",
                    "content":Value::Object(data.clone()).to_string(),
                }));
            }
            Message::Assistant(_) => {}
        }
    }
    items
}

pub(super) fn responses_user_content(content: &UserContent) -> Value {
    match content {
        UserContent::Text(text) => Value::String(text.clone()),
        UserContent::Blocks(blocks) => {
            let content = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(json!({"type":"input_text","text":text})),
                    image @ ContentBlock::Image { .. } => response_image_content(image),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if content.len() == 1 && content[0]["type"] == "input_text" {
                content[0].get("text").cloned().unwrap_or_default()
            } else {
                Value::Array(content)
            }
        }
    }
}

pub(super) fn response_image_content(block: &ContentBlock) -> Option<Value> {
    let ContentBlock::Image {
        data, mime_type, ..
    } = block
    else {
        return None;
    };
    Some(json!({
        "type":"input_image",
        "image_url":format!("data:{mime_type};base64,{data}"),
    }))
}

pub(super) fn prompt_cache_key(request: &ModelRequest) -> Option<&str> {
    request
        .metadata
        .get("promptCacheKey")
        .or_else(|| request.metadata.pointer("/promptCache/sessionKey"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}
