use mon_agent_core::{ContentBlock, Message, ToolResultMessage, UserContent};
use serde_json::{Value, json};

use super::speaker::{assistant_speaker, strip_redundant_speaker_prefix, structured_speaker_name};

pub(super) fn append_openai_message(
    target: &mut Vec<Value>,
    message: &Message,
    active_assistant_id: Option<&str>,
) {
    match message {
        Message::User { content, .. } => {
            target.push(json!({"role": "user", "content": user_content(content)}));
        }
        Message::Assistant(message) => {
            if message.is_terminal_failure() {
                return;
            }
            let speaker = assistant_speaker(message);
            let mut text = text_content(&message.content);
            if let Some((_, names)) = &speaker {
                text = strip_redundant_speaker_prefix(&text, names);
            }
            let calls = message
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => Some(json!({
                        "id": id,
                        "type": "function",
                        "function": {"name": name, "arguments": arguments.to_string()},
                    })),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if text.trim().is_empty() && calls.is_empty() {
                return;
            }
            let mut value = json!({"role": "assistant", "content": text});
            if let Some((speaker_id, _)) = &speaker
                && active_assistant_id.is_some_and(|active| active != speaker_id)
            {
                value["name"] = Value::String(structured_speaker_name(speaker_id));
            }
            if let Some(ContentBlock::Thinking { thinking, extra }) = message.content.iter().find(
                |block| matches!(block, ContentBlock::Thinking { thinking, .. } if !thinking.trim().is_empty()),
            ) {
                let mut signature = extra
                    .get("thinkingSignature")
                    .and_then(Value::as_str)
                    .unwrap_or("reasoning_content");
                if message.provider == "opencode-go" && signature == "reasoning" {
                    signature = "reasoning_content";
                }
                value[signature] = Value::String(thinking.clone());
            }
            if !calls.is_empty() {
                value["tool_calls"] = Value::Array(calls);
            }
            target.push(value);
        }
        Message::ToolResult(result) => append_tool_result(target, result),
        Message::CompactionSummary { data } => {
            let summary = data
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or_default();
            target.push(json!({
                "role":"user",
                "content":format!("The conversation history before this point was compacted into the following summary:\n\n<summary>\n{summary}\n</summary>"),
            }));
        }
        Message::BranchSummary { data } => {
            if let Some(summary) = data.get("summary").and_then(Value::as_str) {
                target.push(json!({"role":"user","content":format!("<branch_summary>\n{summary}\n</branch_summary>")}));
            }
        }
        Message::Custom { data } => {
            if let Some(content) = data
                .get("content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                target.push(json!({"role":"user","content":content}));
            }
        }
        Message::BashExecution { data } => {
            target.push(json!({"role":"user","content":Value::Object(data.clone()).to_string()}));
        }
    }
}

pub(super) fn append_tool_result(target: &mut Vec<Value>, result: &ToolResultMessage) {
    let text = text_content(&result.content);
    let content = result.structured_content.as_ref().map_or_else(
        || text.clone(),
        |structured| {
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
    target.push(json!({
        "role": "tool",
        "tool_call_id": result.tool_call_id,
        "content": if content.is_empty() && !images.is_empty() { "The tool returned an image." } else { &content },
    }));
    if !images.is_empty() {
        let mut parts = vec![json!({
            "type":"text",
            "text":format!("The following image was returned by {}. Analyze it directly.", result.tool_name),
        })];
        parts.extend(images.iter().filter_map(|block| match block {
            ContentBlock::Image {
                data, mime_type, ..
            } => Some(json!({
                "type":"image_url",
                "image_url":{"url":format!("data:{mime_type};base64,{data}")},
            })),
            _ => None,
        }));
        target.push(json!({"role":"user","content":parts}));
    }
}

pub(super) fn user_content(content: &UserContent) -> Value {
    match content {
        UserContent::Text(text) => Value::String(text.clone()),
        UserContent::Blocks(blocks) => {
            let parts = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(json!({"type": "text", "text": text})),
                    ContentBlock::Image {
                        data, mime_type, ..
                    } => Some(json!({
                        "type": "image_url",
                        "image_url": {"url": format!("data:{mime_type};base64,{data}")},
                    })),
                    _ => None,
                })
                .collect::<Vec<_>>();
            Value::Array(parts)
        }
    }
}

pub(super) fn text_content(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
