use mon_agent_core::{
    AssistantMessage, ContentBlock, Message, ModelAdapter, ModelError, ModelRequest, ModelSpec,
    event_channel,
};
use mon_agent_domain::SessionId;
use mon_agent_store::{MemoryRecord, Store, StoreError};
use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

const EXTRACTION_PROMPT: &str = r#"你是长期记忆提取器。只提取用户明确陈述或双方已经确认、未来跨会话仍有用的稳定信息。
允许类型：preference（用户偏好）、fact（稳定事实）、decision（已确认长期决策）、procedure（可复用流程）。
不要提取临时任务进度、问题本身、模型推测、工具原始输出、寒暄、密码、密钥、令牌或其他认证信息。
如果没有值得长期保存的信息，返回 {"memories":[]}。
只输出严格 JSON：{"memories":[{"kind":"preference|fact|decision|procedure","content":"独立、清楚、第三人称陈述","confidence":0.0}]}。
所有长期记忆都属于当前智能体角色，不存在跨角色共享的用户记忆。
仅输出置信度不低于 0.85 的候选；宁可遗漏，不要猜测。"#;

#[derive(Debug, Deserialize)]
struct Extraction {
    #[serde(default)]
    memories: Vec<Candidate>,
}

#[derive(Debug, Deserialize)]
struct Candidate {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    confidence: f64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ExtractionError {
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("memory extractor returned invalid JSON: {0}")]
    InvalidJson(String),
}

pub(crate) struct ExtractionRequest<'a> {
    pub(crate) store: &'a Store,
    pub(crate) model: Arc<dyn ModelAdapter>,
    pub(crate) model_spec: &'a ModelSpec,
    pub(crate) session_id: SessionId,
    pub(crate) input_id: &'a str,
    pub(crate) user_text: &'a str,
    pub(crate) assistant_text: &'a str,
    pub(crate) assistant_id: Option<&'a str>,
    pub(crate) character_id: &'a str,
    pub(crate) cancellation: CancellationToken,
}

pub(crate) async fn extract_turn_memories(
    request: ExtractionRequest<'_>,
) -> Result<Vec<MemoryRecord>, ExtractionError> {
    let ExtractionRequest {
        store,
        model,
        model_spec,
        session_id,
        input_id,
        user_text,
        assistant_text,
        assistant_id,
        character_id,
        cancellation,
    } = request;
    if user_text.trim().is_empty() || assistant_text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let request = ModelRequest {
        model: model_spec.clone(),
        system_prompt: EXTRACTION_PROMPT.to_owned(),
        messages: vec![Message::user(format!(
            "用户消息：\n{}\n\n助手最终回复：\n{}",
            truncate(user_text, 6_000),
            truncate(assistant_text, 6_000)
        ))],
        tools: Vec::new(),
        session_id: Some(session_id.to_string()),
        metadata: json!({"purpose":"automatic_memory_extraction"}),
    };
    let (emitter, mut events) = event_channel(128);
    let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
    let output = model.generate(request, emitter, cancellation).await;
    let _ = drain.await;
    let output = output?;
    let parsed = parse_extraction(&assistant_message_text(&output.message))?;
    let mut saved = Vec::new();
    for candidate in parsed.memories {
        let content = normalize(&candidate.content);
        if !valid_candidate(&candidate.kind, &content, candidate.confidence) {
            continue;
        }
        let duplicate = store
            .search_memories_in_scope("agent_character", character_id, Some(&content), 5)
            .await?
            .into_iter()
            .any(|memory| memory.content.eq_ignore_ascii_case(&content));
        if duplicate {
            continue;
        }
        saved.push(
            store
                .create_memory(
                    &content,
                    &candidate.kind,
                    "agent_character",
                    character_id,
                    &session_id.to_string(),
                    json!({
                        "source":"automatic_extraction",
                        "sourceInputId":input_id,
                        "sourceAssistantId":assistant_id,
                        "confidence":candidate.confidence,
                    }),
                )
                .await?,
        );
    }
    Ok(saved)
}

pub(crate) fn final_assistant_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant(message) => Some(assistant_message_text(message)),
            _ => None,
        })
        .unwrap_or_default()
}

fn assistant_message_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn parse_extraction(text: &str) -> Result<Extraction, ExtractionError> {
    let text = text.trim();
    let start = text
        .find('{')
        .ok_or_else(|| ExtractionError::InvalidJson("missing object".to_owned()))?;
    let end = text
        .rfind('}')
        .ok_or_else(|| ExtractionError::InvalidJson("missing object".to_owned()))?;
    serde_json::from_str(&text[start..=end])
        .map_err(|error| ExtractionError::InvalidJson(error.to_string()))
}

fn valid_candidate(kind: &str, content: &str, confidence: f64) -> bool {
    matches!(kind, "preference" | "fact" | "decision" | "procedure")
        && confidence >= 0.85
        && !content.is_empty()
        && content.chars().count() <= 4_000
        && !secret_pattern().is_match(content)
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|token|password|密码|密钥|令牌)\s*[:=：]\s*\S+)",
        )
        .expect("valid memory secret regex")
    })
}

fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use mon_agent_core::{EventEmitter, ModelOutput};

    #[derive(Clone)]
    struct ExtractionModel;

    #[async_trait]
    impl ModelAdapter for ExtractionModel {
        async fn generate(
            &self,
            _request: ModelRequest,
            _events: EventEmitter,
            _cancellation: CancellationToken,
        ) -> Result<ModelOutput, ModelError> {
            Ok(ModelOutput::complete(AssistantMessage::text(
                r#"{"memories":[{"kind":"preference","content":"用户偏好简洁回答","confidence":0.96},{"kind":"fact","content":"api_key: sk-abcdefghijklmnop","confidence":0.99}]}"#,
            )))
        }
    }

    #[test]
    fn parser_accepts_fenced_json_and_filters_unsafe_candidates() {
        let parsed = parse_extraction(
            "```json\n{\"memories\":[{\"kind\":\"preference\",\"content\":\"用户偏好简洁回答\",\"confidence\":0.96}]}\n```",
        )
        .expect("parse");
        assert_eq!(parsed.memories.len(), 1);
        assert!(valid_candidate(
            &parsed.memories[0].kind,
            &parsed.memories[0].content,
            parsed.memories[0].confidence
        ));
        assert!(!valid_candidate(
            "fact",
            "api_key: sk-abcdefghijklmnop",
            0.99
        ));
        assert!(!valid_candidate("guess", "用户可能喜欢蓝色", 0.99));
        assert!(!valid_candidate("fact", "稳定事实", 0.2));
    }

    #[tokio::test]
    async fn extraction_persists_only_safe_character_memory_and_deduplicates() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("memory").await.expect("session");
        let model: Arc<dyn ModelAdapter> = Arc::new(ExtractionModel);
        let first = extract_turn_memories(ExtractionRequest {
            store: &store,
            model: Arc::clone(&model),
            model_spec: &ModelSpec::default(),
            session_id: session.id,
            input_id: "input-1",
            user_text: "以后回答简洁一点",
            assistant_text: "好的，我会保持简洁。",
            assistant_id: Some("3"),
            character_id: "7",
            cancellation: CancellationToken::new(),
        })
        .await
        .expect("extract");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].scope_type, "agent_character");
        assert_eq!(first[0].scope_key, "7");
        assert_eq!(first[0].metadata["source"], "automatic_extraction");
        let second = extract_turn_memories(ExtractionRequest {
            store: &store,
            model,
            model_spec: &ModelSpec::default(),
            session_id: session.id,
            input_id: "input-2",
            user_text: "记得简洁",
            assistant_text: "好的。",
            assistant_id: Some("3"),
            character_id: "7",
            cancellation: CancellationToken::new(),
        })
        .await
        .expect("extract again");
        assert!(second.is_empty());
    }
}
