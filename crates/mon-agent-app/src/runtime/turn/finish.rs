use super::{SelfAwakeState, execute::DirectedTurnResult};
use crate::runtime::{RuntimeError, RuntimeInner};
use crate::{director, memory, prompt, self_awake, session_title};
use mon_agent_core::{AgentError, ModelSpec};
use mon_agent_store::InputRecord;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub(super) struct FinishContext {
    pub(super) inner: Arc<RuntimeInner>,
    pub(super) input: InputRecord,
    pub(super) cancellation: CancellationToken,
    pub(super) plan: director::DirectorPlan,
    pub(super) directed: bool,
    pub(super) prompt_profile: prompt::PromptProfile,
    pub(super) internal_handoff: bool,
    pub(super) input_text: String,
    pub(super) session_participants: Vec<Value>,
    pub(super) self_awake_state: Option<SelfAwakeState>,
    pub(super) active_model_spec: ModelSpec,
}

pub(super) async fn finish_turn(
    context: FinishContext,
    run_result: Result<DirectedTurnResult, RuntimeError>,
) -> Result<(), RuntimeError> {
    let FinishContext {
        inner,
        input,
        cancellation,
        plan,
        directed,
        prompt_profile,
        internal_handoff,
        input_text,
        session_participants,
        self_awake_state,
        active_model_spec,
    } = context;
    match run_result {
        Ok(result) => {
            let final_assistant_text = memory::final_assistant_text(&result.new_messages);
            if directed {
                inner
                    .store
                    .append_event(
                        input.session_id,
                        Some(input.turn_id),
                        "companion.director.completed",
                        json!({
                            "sessionID":input.session_id,
                            "planID":plan.plan_id,
                            "status":"completed",
                            "completedBeatIndexes":(0..plan.beats.len()).collect::<Vec<_>>(),
                        }),
                    )
                    .await?;
            }
            if prompt_profile == prompt::PromptProfile::UserChat && !internal_handoff {
                if let Some(character_id) = prompt::primary_character_id(&session_participants) {
                    let assistant_text = final_assistant_text.clone();
                    if !input_text.trim().is_empty() && !assistant_text.trim().is_empty() {
                        let extraction_started = inner
                            .store
                            .append_event(
                                input.session_id,
                                Some(input.turn_id),
                                "memory.extraction_started",
                                json!({"inputId":input.id,"characterId":character_id}),
                            )
                            .await?;
                        let _ = extraction_started;
                        let input_id = input.id.to_string();
                        let assistant_id = prompt::primary_assistant_id(&session_participants);
                        match memory::extract_turn_memories(memory::ExtractionRequest {
                            store: &inner.store,
                            model: Arc::clone(&inner.model),
                            model_spec: &active_model_spec,
                            session_id: input.session_id,
                            input_id: &input_id,
                            user_text: &input_text,
                            assistant_text: &assistant_text,
                            assistant_id: assistant_id.as_deref(),
                            character_id: &character_id,
                            cancellation: cancellation.child_token(),
                        })
                        .await
                        {
                            Ok(saved) => {
                                inner
                                    .store
                                    .append_event(
                                        input.session_id,
                                        Some(input.turn_id),
                                        "memory.extraction_completed",
                                        json!({"inputId":input.id,"memoryIds":saved.iter().map(|memory|memory.id).collect::<Vec<_>>()}),
                                    )
                                    .await?;
                            }
                            Err(error) => {
                                warn!(%error, session_id = %input.session_id, turn_id = %input.turn_id, "long-term memory extraction failed; completing turn without memories");
                                inner
                                    .store
                                    .append_event(
                                        input.session_id,
                                        Some(input.turn_id),
                                        "memory.extraction_failed",
                                        json!({"inputId":input.id,"reason":error.to_string()}),
                                    )
                                    .await?;
                            }
                        }
                    }
                }
            }
            if let Some((job, run, request)) = &self_awake_state {
                let assistant_text = final_assistant_text.clone();
                let trigger = job
                    .payload
                    .get("trigger")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"scheduled"}));
                let decision = self_awake::parse_decision(&assistant_text, &trigger);
                self_awake::apply_decision(&inner.store, run, input.turn_id, &trigger, &decision)
                    .await?;
                let decision_value = serde_json::to_value(&decision)
                    .unwrap_or_else(|_| json!({"action":"observe_only"}));
                let diary = self_awake::diary_value(&decision);
                let notification =
                    self_awake::notification_value(&decision, &trigger).map(|mut notification| {
                        if let Some(object) = notification.as_object_mut() {
                            object.insert("runId".to_owned(), json!(run.id));
                        }
                        notification
                    });
                let next_wake = self_awake::next_wake(run, &decision);
                let next_job = inner
                    .store
                    .complete_self_awake_run(
                        run,
                        decision_value.clone(),
                        diary,
                        notification.clone(),
                        Some(next_wake),
                    )
                    .await?;
                inner
                    .store
                    .append_event(
                        input.session_id,
                        Some(input.turn_id),
                        "self_awake.completed",
                        json!({
                            "runId":run.id,
                            "jobId":job.id,
                            "request":self_awake::to_value(request),
                            "decision":decision_value,
                            "notificationRequested":notification.is_some(),
                            "notification":notification,
                            "nextJobId":next_job.map(|job|job.id),
                        }),
                    )
                    .await?;
            }
            if let Some(memo_id) = input.payload.get("memoId").and_then(Value::as_i64) {
                inner.store.mark_memo_triggered(memo_id).await?;
            }
            if prompt_profile != prompt::PromptProfile::SelfAwake
                && let Some(job_id) = input
                    .payload
                    .get("jobId")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse().ok())
            {
                inner.store.complete_job(job_id).await?;
            }
            let completed = inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "turn.completed",
                    json!({"turns": result.turns, "messageCount": result.new_messages.len()}),
                )
                .await?;
            let _ = completed;
            let input_completed = inner.store.complete_input(&input).await?;
            let _ = input_completed;
            if prompt_profile == prompt::PromptProfile::UserChat
                && !internal_handoff
                && !input_text.trim().is_empty()
                && !final_assistant_text.trim().is_empty()
            {
                tokio::spawn(session_title::generate_initial_title(
                    inner.store.clone(),
                    Arc::clone(&inner.model),
                    active_model_spec,
                    input.session_id,
                    input_text.to_owned(),
                    final_assistant_text,
                ));
            }
            Ok(())
        }
        Err(error) => {
            let reason = error.to_string();
            if let Some((job, run, _)) = &self_awake_state {
                inner.store.fail_self_awake_run(job.id, &reason).await?;
                inner
                    .store
                    .append_event(
                        input.session_id,
                        Some(input.turn_id),
                        "self_awake.failed",
                        json!({"runId":run.id,"jobId":job.id,"reason":reason}),
                    )
                    .await?;
            }
            if directed {
                inner
                    .store
                    .append_event(
                        input.session_id,
                        Some(input.turn_id),
                        "companion.director.failed",
                        json!({
                            "sessionID":input.session_id,
                            "planID":plan.plan_id,
                            "status":"failed",
                            "error":reason,
                        }),
                    )
                    .await?;
            }
            let failed = inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "turn.failed",
                    json!({"reason": reason, "cancelled": cancellation.is_cancelled()}),
                )
                .await?;
            let _ = failed;
            let interrupted = inner.store.interrupt_input(&input, &reason).await?;
            let _ = interrupted;
            if let Some(job_id) = input
                .payload
                .get("jobId")
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
            {
                inner
                    .store
                    .fail_job(
                        job_id,
                        &reason,
                        Some(chrono::Utc::now().timestamp_millis() + 30_000),
                    )
                    .await?;
            }
            Err(RuntimeError::Agent(AgentError::Hook(reason)))
        }
    }
}
