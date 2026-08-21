use super::{conversation_entries, prompt_section, skill_prompt_section};
use crate::runtime::{EVENT_CHANNEL_CAPACITY, RuntimeError, RuntimeInner};
use mon_agent_core::{
    AgentContext, AgentError, LoopHooks, Message, ModelAdapter, ModelRequest, ModelSpec,
    ToolDefinition, ToolRegistry, build_compaction_summary_request, estimate_context_tokens,
    estimate_prompt_token_breakdown, event_channel, finalize_compaction, prepare_compaction,
    sanitize_model_history, should_compact, tokenizer_name,
};
use mon_agent_domain::{SessionId, TurnId};
use mon_agent_store::{InputRecord, Store, StoreError};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
struct LoopCompactionState {
    source_message_count: usize,
    compacted_context: AgentContext,
}

pub(in crate::runtime) struct RuntimeLoopHooks {
    store: Store,
    model: Arc<dyn ModelAdapter>,
    model_spec: ModelSpec,
    tools: Vec<ToolDefinition>,
    session_id: SessionId,
    turn_id: TurnId,
    assistant_id: String,
    state: Mutex<Option<LoopCompactionState>>,
    last_prepared_context: Mutex<Option<AgentContext>>,
}

impl RuntimeLoopHooks {
    pub(in crate::runtime) fn new(
        inner: &RuntimeInner,
        tools: &ToolRegistry,
        model_spec: ModelSpec,
        session_id: SessionId,
        turn_id: TurnId,
        assistant_id: String,
    ) -> Self {
        Self {
            store: inner.store.clone(),
            model: Arc::clone(&inner.model),
            model_spec,
            tools: tools.direct_definitions(),
            session_id,
            turn_id,
            assistant_id,
            state: Mutex::new(None),
            last_prepared_context: Mutex::new(None),
        }
    }

    async fn persist_context_usage(
        &self,
        context: &AgentContext,
        phase: &str,
        provider_usage: Option<&Value>,
    ) -> Result<(), AgentError> {
        let breakdown = estimate_prompt_token_breakdown(
            &context.system_prompt,
            prompt_section(&context.system_prompt, "# 身份"),
            skill_prompt_section(&context.system_prompt),
            &self.tools,
            &context.messages,
            Some(&self.model_spec.id),
        );
        let cache = context.metadata.get("promptCache").unwrap_or(&Value::Null);
        let usage_number = |key: &str| {
            provider_usage
                .and_then(|usage| usage.get(key))
                .and_then(Value::as_u64)
                .unwrap_or_default()
        };
        let provider_input = usage_number("input");
        let provider_output = usage_number("output");
        let provider_total =
            usage_number("totalTokens").max(provider_input.saturating_add(provider_output));
        let context_tokens = if provider_total > 0 {
            provider_total
        } else {
            breakdown.total as u64
        };
        let provider_adjustment = if provider_input > 0 {
            i64::try_from(provider_input).unwrap_or(i64::MAX)
                - i64::try_from(breakdown.total).unwrap_or(i64::MAX)
        } else {
            0
        };
        let cache_read = usage_number("cacheRead");
        let cache_miss = usage_number("cacheMiss");
        let cache_denominator = if provider_input > 0 {
            provider_input
        } else {
            cache_read.saturating_add(cache_miss)
        };
        let cache_hit_rate = if cache_denominator == 0 {
            0.0
        } else {
            (cache_read as f64 / cache_denominator as f64).clamp(0.0, 1.0)
        };
        self.store
            .append_event(
                self.session_id,
                Some(self.turn_id),
                "context.usage_updated",
                json!({
                    "assistantId":self.assistant_id,
                    "modelId":self.model_spec.id,
                    "contextTokens":context_tokens,
                    "tokenBreakdown":{
                        "character":breakdown.identity,
                        "skills":breakdown.skills,
                        "system":breakdown.system,
                        "tools":breakdown.tools,
                        "history":breakdown.history,
                        "cacheRead":cache_read,
                        "cacheMiss":cache_miss,
                        "cacheHitRate":cache_hit_rate,
                        "providerInput":(provider_input > 0).then_some(provider_input),
                        "providerOutput":(provider_total > 0).then_some(provider_output),
                        "providerAdjustment":provider_adjustment,
                        "contextMeasurement":if provider_total > 0 { "provider" } else { "estimated" },
                        "promptCacheFingerprint":cache.get("fingerprint"),
                        "promptCacheEpoch":cache.get("epoch").and_then(Value::as_u64).unwrap_or_default(),
                        "promptCacheInvalidationReason":cache.get("invalidationReason"),
                        "tokenizer":tokenizer_name(Some(&self.model_spec.id)),
                        "tokenizerModel":self.model_spec.id,
                    },
                    "phase":phase,
                    "updatedAt":mon_agent_core::now_ms(),
                }),
            )
            .await
            .map_err(|error| AgentError::Hook(error.to_string()))?;
        Ok(())
    }

    async fn remember_prepared_context(&self, context: &AgentContext) {
        *self.last_prepared_context.lock().await = Some(context.clone());
    }

    pub(in crate::runtime) async fn persist_completed_context(
        &self,
        final_message: Option<&Message>,
    ) -> Result<(), AgentError> {
        let Some(mut context) = self.last_prepared_context.lock().await.clone() else {
            return Ok(());
        };
        if let Some(message) = final_message {
            context.messages.push(message.clone());
            context.messages = sanitize_model_history(&context.messages);
        }
        let provider_usage = final_message.and_then(|message| match message {
            Message::Assistant(message) => message.usage.as_ref(),
            _ => None,
        });
        self.persist_context_usage(&context, "completed", provider_usage)
            .await
    }

    async fn candidate_context(&self, context: AgentContext) -> (AgentContext, usize) {
        let clean_messages = sanitize_model_history(&context.messages);
        let source_message_count = clean_messages.len();
        let state = self.state.lock().await;
        let Some(previous) = state.as_ref() else {
            return (
                AgentContext {
                    messages: clean_messages,
                    ..context
                },
                source_message_count,
            );
        };
        if clean_messages.len() < previous.source_message_count {
            return (
                AgentContext {
                    messages: clean_messages,
                    ..context
                },
                source_message_count,
            );
        }
        let mut candidate = previous.compacted_context.clone();
        candidate.system_prompt = context.system_prompt;
        candidate.metadata = context.metadata;
        candidate
            .messages
            .extend_from_slice(&clean_messages[previous.source_message_count..]);
        candidate.messages = sanitize_model_history(&candidate.messages);
        (candidate, source_message_count)
    }
}

#[async_trait::async_trait]
impl LoopHooks for RuntimeLoopHooks {
    async fn prepare_model_context(
        &self,
        context: AgentContext,
        cancellation: CancellationToken,
    ) -> Result<AgentContext, AgentError> {
        let (candidate, source_message_count) = self.candidate_context(context).await;
        let context_window = self.model_spec.context_window.unwrap_or(u64::MAX) as usize;
        let settings = compaction_settings(context_window);
        let tokens = estimate_prompt_token_breakdown(
            &candidate.system_prompt,
            prompt_section(&candidate.system_prompt, "# 身份"),
            skill_prompt_section(&candidate.system_prompt),
            &self.tools,
            &candidate.messages,
            Some(&self.model_spec.id),
        )
        .total;
        if !should_compact(tokens, context_window, &settings) {
            self.persist_context_usage(&candidate, "prepared", None)
                .await?;
            self.remember_prepared_context(&candidate).await;
            return Ok(candidate);
        }

        let entries = candidate
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                json!({
                    "type":"message",
                    "id":format!("loop-{index}"),
                    "message":message,
                })
            })
            .collect::<Vec<_>>();
        let Some(preparation) = prepare_compaction(&entries, &settings, Some(&self.model_spec.id))
            .map_err(AgentError::Hook)?
        else {
            return Ok(candidate);
        };
        let request_value = build_compaction_summary_request(
            &preparation,
            &serde_json::to_value(&self.model_spec)
                .map_err(|error| AgentError::Hook(error.to_string()))?,
            None,
            Some("Preserve the active task, tool outcomes, pending work, exact identifiers, and skill constraints."),
            None,
        )
        .map_err(AgentError::Hook)?;
        let summary_context = request_value
            .get("context")
            .ok_or_else(|| AgentError::Hook("loop compaction request has no context".to_owned()))?;
        let request = ModelRequest {
            model: self.model_spec.clone(),
            system_prompt: summary_context
                .get("systemPrompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            messages: serde_json::from_value(
                summary_context
                    .get("messages")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )
            .map_err(|error| AgentError::Hook(error.to_string()))?,
            tools: Vec::new(),
            session_id: Some(self.session_id.to_string()),
            metadata: json!({
                "purpose":"loop_context_compaction",
                "turnId":self.turn_id,
                "assistantId":self.assistant_id,
            }),
        };
        let (emitter, mut events) = event_channel(EVENT_CHANNEL_CAPACITY);
        let drain = async { while events.recv().await.is_some() {} };
        let generation = self
            .model
            .generate(request, emitter, cancellation.child_token());
        let (generated, ()) = tokio::join!(generation, drain);
        let generated = generated.map_err(|error| AgentError::Hook(error.to_string()))?;
        let finalized = finalize_compaction(
            &preparation,
            &serde_json::to_value(generated.message)
                .map_err(|error| AgentError::Hook(error.to_string()))?,
        )
        .map_err(AgentError::Hook)?;
        let first_kept_id = finalized
            .get("firstKeptEntryId")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Hook("loop compaction has no kept boundary".to_owned()))?;
        let first_kept_index = entries
            .iter()
            .position(|entry| entry.get("id").and_then(Value::as_str) == Some(first_kept_id))
            .ok_or_else(|| {
                AgentError::Hook("loop compaction kept boundary is invalid".to_owned())
            })?;
        let summary = serde_json::from_value(json!({
            "role":"compactionSummary",
            "summary":finalized.get("summary"),
            "tokensBefore":finalized.get("tokensBefore"),
            "firstKeptEntryId":finalized.get("firstKeptEntryId"),
            "details":finalized.get("details"),
            "timestamp":mon_agent_core::now_ms(),
        }))
        .map_err(|error| AgentError::Hook(error.to_string()))?;
        let mut compacted = AgentContext {
            system_prompt: candidate.system_prompt,
            messages: vec![summary],
            metadata: candidate.metadata,
        };
        compacted
            .messages
            .extend_from_slice(&candidate.messages[first_kept_index..]);
        compacted.messages = sanitize_model_history(&compacted.messages);
        let mut compacted_breakdown = estimate_prompt_token_breakdown(
            &compacted.system_prompt,
            prompt_section(&compacted.system_prompt, "# 身份"),
            skill_prompt_section(&compacted.system_prompt),
            &self.tools,
            &compacted.messages,
            Some(&self.model_spec.id),
        );
        let reserve = settings
            .get("reserveTokens")
            .and_then(Value::as_u64)
            .unwrap_or(16_384) as usize;
        let prompt_budget = context_window.saturating_sub(reserve);
        let mut evicted_messages = 0_usize;
        while compacted_breakdown.total > prompt_budget && compacted.messages.len() > 3 {
            compacted.messages.remove(1);
            evicted_messages += 1;
            compacted.messages = sanitize_model_history(&compacted.messages);
            compacted_breakdown = estimate_prompt_token_breakdown(
                &compacted.system_prompt,
                prompt_section(&compacted.system_prompt, "# 身份"),
                skill_prompt_section(&compacted.system_prompt),
                &self.tools,
                &compacted.messages,
                Some(&self.model_spec.id),
            );
        }
        if compacted_breakdown.total > prompt_budget {
            return Err(AgentError::Hook(format!(
                "context remains over budget after compaction: {} prompt tokens exceed the {} token prompt budget",
                compacted_breakdown.total, prompt_budget
            )));
        }
        if let Some(metadata) = compacted.metadata.as_object_mut() {
            metadata.insert(
                "loopCompaction".to_owned(),
                json!({
                    "tokensBefore":tokens,
                    "sourceMessages":source_message_count,
                    "resultMessages":compacted.messages.len(),
                    "evictedMessages":evicted_messages,
                    "promptBudget":prompt_budget,
                }),
            );
        }
        self.store
            .append_event(
                self.session_id,
                Some(self.turn_id),
                "context.loop_compacted",
                json!({
                    "assistantId":self.assistant_id,
                    "tokensBefore":tokens,
                    "tokensAfter":compacted_breakdown.total,
                    "sourceMessageCount":source_message_count,
                    "resultMessageCount":compacted.messages.len(),
                    "evictedMessageCount":evicted_messages,
                    "promptBudget":prompt_budget,
                    "summary":finalized,
                }),
            )
            .await
            .map_err(|error| AgentError::Hook(error.to_string()))?;
        *self.state.lock().await = Some(LoopCompactionState {
            source_message_count,
            compacted_context: compacted.clone(),
        });
        self.persist_context_usage(&compacted, "compacted", None)
            .await?;
        self.remember_prepared_context(&compacted).await;
        Ok(compacted)
    }
}

fn compaction_settings(context_window: usize) -> Value {
    let proportional = context_window.saturating_div(4).max(1);
    json!({
        "enabled": true,
        "reserveTokens": 16_384_usize.min(proportional),
        "keepRecentTokens": 8_000_usize.min(proportional),
        "tailTurns": 2,
    })
}

pub(in crate::runtime) async fn compact_if_needed(
    inner: &RuntimeInner,
    input: &InputRecord,
    model_spec: &ModelSpec,
    cancellation: &CancellationToken,
    force: bool,
) -> Result<(), RuntimeError> {
    let context_window = model_spec.context_window.unwrap_or(u64::MAX);
    let events = inner.store.list_events(input.session_id, 0).await?;
    let entries = conversation_entries(&events);
    let messages = entries
        .iter()
        .filter_map(|entry| entry.get("message"))
        .filter_map(|message| serde_json::from_value::<Message>(message.clone()).ok())
        .collect::<Vec<_>>();
    let messages = sanitize_model_history(&messages);
    let tokens = estimate_context_tokens(&messages, Some(&model_spec.id)).tokens;
    let settings = compaction_settings(context_window as usize);
    if !force && !should_compact(tokens, context_window as usize, &settings) {
        return Ok(());
    }
    let Some(preparation) =
        prepare_compaction(&entries, &settings, Some(&model_spec.id)).map_err(AgentError::Hook)?
    else {
        return Ok(());
    };
    let request_value = build_compaction_summary_request(
        &preparation,
        &serde_json::to_value(model_spec).map_err(StoreError::from)?,
        None,
        input.payload.get("instructions").and_then(Value::as_str),
        None,
    )
    .map_err(AgentError::Hook)?;
    let context = request_value
        .get("context")
        .ok_or_else(|| AgentError::Hook("compaction request has no context".to_owned()))?;
    let request = ModelRequest {
        model: model_spec.clone(),
        system_prompt: context
            .get("systemPrompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        messages: serde_json::from_value(
            context
                .get("messages")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .map_err(StoreError::from)?,
        tools: Vec::new(),
        session_id: Some(input.session_id.to_string()),
        metadata: json!({"purpose":"context_compaction","turnId":input.turn_id}),
    };
    let (emitter, mut streamed_events) = event_channel(EVENT_CHANNEL_CAPACITY);
    let drain = async { while streamed_events.recv().await.is_some() {} };
    let generation = inner
        .model
        .generate(request, emitter, cancellation.child_token());
    let (result, ()) = tokio::join!(generation, drain);
    let output = result.map_err(|error| AgentError::Hook(error.to_string()))?;
    let finalized = finalize_compaction(
        &preparation,
        &serde_json::to_value(output.message).map_err(StoreError::from)?,
    )
    .map_err(AgentError::Hook)?;
    inner
        .store
        .append_event(
            input.session_id,
            Some(input.turn_id),
            "context.compacted",
            finalized,
        )
        .await?;
    Ok(())
}
