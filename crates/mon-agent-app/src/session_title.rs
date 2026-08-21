use mon_agent_core::{ContentBlock, Message, ModelAdapter, ModelRequest, ModelSpec, event_channel};
use mon_agent_domain::SessionId;
use mon_agent_store::Store;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

const TITLE_SYSTEM_PROMPT: &str = r#"你是会话标题生成器。只输出一个便于用户日后查找本次会话的标题。
要求：
- 与用户消息使用相同语言；
- 单行，不超过 50 个字符；
- 聚焦用户真正要讨论或完成的主题；
- 不解释、不回答问题、不使用引号或 Markdown；
- 不写工具名或“生成标题”“总结会话”等过程描述。"#;

pub async fn generate_initial_title(
    store: Store,
    model: Arc<dyn ModelAdapter>,
    model_spec: ModelSpec,
    session_id: SessionId,
    user_text: String,
    assistant_text: String,
) {
    if user_text.trim().is_empty() {
        return;
    }
    match store.claim_session_title_generation(session_id).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::warn!(%error, %session_id, "failed to claim session title generation");
            return;
        }
    }

    let fallback = fallback_session_title(&user_text);
    let mut title_model = model_spec;
    title_model.max_tokens = Some(title_model.max_tokens.unwrap_or(100).min(100));
    title_model
        .extra
        .insert("temperature".to_owned(), json!(0.2));
    let (events, mut receiver) = event_channel(16);
    let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
    let request = ModelRequest {
        model: title_model,
        system_prompt: TITLE_SYSTEM_PROMPT.to_owned(),
        messages: vec![Message::user(format!(
            "用户首轮请求：\n{}\n\n助手首轮回复：\n{}",
            truncate_chars(&user_text, 4_000),
            truncate_chars(&assistant_text, 4_000)
        ))],
        tools: Vec::new(),
        session_id: Some(session_id.to_string()),
        metadata: json!({"purpose":"session_title","sessionId":session_id}),
    };
    let cancellation = CancellationToken::new();
    let generated = timeout(
        Duration::from_secs(30),
        model.generate(request, events, cancellation.clone()),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|output| assistant_text_from_blocks(&output.message.content))
    .and_then(|title| normalize_generated_title(&title));
    cancellation.cancel();
    let _ = drain.await;
    let (title, source) = generated
        .map(|title| (title, "generated"))
        .unwrap_or((fallback, "fallback"));
    if let Err(error) = store.set_session_title(session_id, &title, source).await {
        tracing::warn!(%error, %session_id, "failed to persist generated session title");
    }
}

pub fn fallback_session_title(user_text: &str) -> String {
    let normalized = user_text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return "新会话".to_owned();
    }
    if normalized.chars().count() > 50 {
        format!("{}...", truncate_chars(&normalized, 47))
    } else {
        normalized
    }
}

pub fn normalize_generated_title(value: &str) -> Option<String> {
    let mut title = value.split_whitespace().collect::<Vec<_>>().join(" ");
    title = title
        .trim_matches(|character: char| matches!(character, '`' | '#' | '*' | '_' | ' '))
        .to_owned();
    let quote_pairs = [('"', '"'), ('\'', '\''), ('“', '”'), ('‘', '’')];
    if title.chars().count() >= 2 {
        if let Some((left, right)) = quote_pairs
            .iter()
            .find(|(left, right)| title.starts_with(*left) && title.ends_with(*right))
        {
            if let Some(unquoted) = title
                .strip_prefix(*left)
                .and_then(|value| value.strip_suffix(*right))
                .map(|value| value.trim().to_owned())
            {
                title = unquoted;
            }
        }
    }
    let title = truncate_chars(&title, 50).trim().to_owned();
    (!title.is_empty()).then_some(title)
}

fn assistant_text_from_blocks(blocks: &[ContentBlock]) -> Option<String> {
    let text = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned();
    (!text.is_empty()).then_some(text)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_is_single_line_and_bounded() {
        let title = fallback_session_title(&format!("  第一行\n第二行  {}", "长".repeat(60)));
        assert!(!title.contains('\n'));
        assert_eq!(title.chars().count(), 50);
        assert!(title.ends_with("..."));
    }

    #[test]
    fn generated_title_removes_markdown_and_quotes() {
        assert_eq!(
            normalize_generated_title("**\"修复会话标题\"**").as_deref(),
            Some("修复会话标题")
        );
        assert_eq!(
            normalize_generated_title("`会话标题生成`").as_deref(),
            Some("会话标题生成")
        );
    }
}
