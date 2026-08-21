use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use mon_agent_blob::BlobService;
use mon_agent_core::{AgentError, ContentBlock, Message, UserContent};
use mon_agent_domain::BlobId;
use serde_json::{Value, json};

pub(super) fn message_content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(super) fn user_message_text(message: &Message) -> Option<String> {
    let Message::User { content, .. } = message else {
        return None;
    };
    let text = match content {
        UserContent::Text(text) => text.clone(),
        UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    };
    (!text.trim().is_empty()).then_some(text)
}

pub(super) fn attachment_summary(payload: &Value) -> String {
    payload
        .get("attachments")
        .and_then(Value::as_array)
        .map(|attachments| {
            attachments
                .iter()
                .map(|attachment| {
                    format!(
                        "- {} ({})",
                        attachment
                            .get("filename")
                            .and_then(Value::as_str)
                            .unwrap_or("attachment"),
                        attachment
                            .get("mime")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub(super) async fn build_user_message(
    blobs: Option<&BlobService>,
    payload: &Value,
    text: &str,
) -> Result<Message, AgentError> {
    let attachments = payload
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if attachments.is_empty() {
        let mut message = Message::user(text);
        if payload
            .get("internalHandoff")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && let Message::User { extra, .. } = &mut message
        {
            extra.insert("display".to_owned(), Value::Bool(false));
            extra.insert("transient".to_owned(), Value::Bool(true));
            extra.insert("internalHandoff".to_owned(), Value::Bool(true));
        }
        return Ok(message);
    }
    let blobs = blobs.ok_or_else(|| AgentError::Hook("blob service is unavailable".to_owned()))?;
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text {
            text: text.to_owned(),
        });
    }
    for attachment in attachments {
        let id: BlobId = attachment
            .get("blobId")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Hook("attachment has no blobId".to_owned()))?
            .parse()
            .map_err(|error| AgentError::Hook(format!("invalid attachment blobId: {error}")))?;
        let (record, bytes) = blobs
            .read(id)
            .await
            .map_err(|error| AgentError::Hook(error.to_string()))?;
        if record.mime.starts_with("image/") {
            blocks.push(ContentBlock::Image {
                data: BASE64.encode(bytes),
                mime_type: record.mime,
                source: Some(json!({"type":"blob","blobId":id})),
            });
        } else if record.mime.starts_with("text/") || record.mime == "application/json" {
            let content = String::from_utf8(bytes)
                .map_err(|_| AgentError::Hook(format!("text attachment is not UTF-8: {id}")))?;
            let filename = attachment
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("attachment");
            blocks.push(ContentBlock::Text {
                text: format!(
                    "<attachment name={filename:?} mime={:?}>\n{content}\n</attachment>",
                    record.mime
                ),
            });
        } else {
            return Err(AgentError::Hook(format!(
                "unsupported model attachment MIME type: {}",
                record.mime
            )));
        }
    }
    Ok(Message::User {
        content: UserContent::Blocks(blocks),
        timestamp: mon_agent_core::now_ms(),
        extra: serde_json::Map::new(),
    })
}
