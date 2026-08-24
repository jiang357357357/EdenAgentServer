use super::SelfAwakeState;
use crate::runtime::context::{compact_if_needed, director_conversation_context, rebuild_context};
use crate::runtime::message::{attachment_summary, build_user_message};
use crate::runtime::{RuntimeError, RuntimeInner};
use crate::{director, prompt, self_awake};
use eden_agent_core::{AgentContext, AgentError, Message, ModelSpec};
use eden_agent_store::{InputRecord, StoreError};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub(super) enum PrepareOutcome {
    Completed,
    Ready(Box<PreparedTurn>),
}

pub(super) struct PreparedTurn {
    pub(super) active_model_spec: ModelSpec,
    pub(super) session_participants: Vec<Value>,
    pub(super) session_environment: Value,
    pub(super) session_events: Vec<eden_agent_store::EventRecord>,
    pub(super) runtime_participants: Vec<Value>,
    pub(super) input_text: String,
    pub(super) internal_handoff: bool,
    pub(super) prompt_profile: prompt::PromptProfile,
    pub(super) self_awake_state: Option<SelfAwakeState>,
    pub(super) effective_text: String,
    pub(super) context: AgentContext,
    pub(super) prompt: Message,
    pub(super) plan: director::DirectorPlan,
    pub(super) directed: bool,
}

pub(super) async fn prepare_turn(
    inner: &Arc<RuntimeInner>,
    input: &InputRecord,
    cancellation: &CancellationToken,
) -> Result<PrepareOutcome, RuntimeError> {
    let started = inner
        .store
        .append_event(
            input.session_id,
            Some(input.turn_id),
            "turn.started",
            json!({"inputId": input.id}),
        )
        .await?;
    let _ = started;

    let force_compaction = input
        .payload
        .get("compact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_key = input.session_id.to_string();
    let active_model_spec = inner
        .model
        .model_spec_for(Some(&session_key))
        .await
        .unwrap_or_else(|| inner.model_spec.clone());
    if let Err(error) = compact_if_needed(
        inner,
        input,
        &active_model_spec,
        cancellation,
        force_compaction,
    )
    .await
    {
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "context.compaction_failed",
                json!({"reason": error.to_string()}),
            )
            .await?;
        if force_compaction {
            inner
                .store
                .interrupt_input(input, &error.to_string())
                .await?;
            return Err(error);
        }
    }
    if force_compaction {
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "turn.completed",
                json!({"compacted":true}),
            )
            .await?;
        inner.store.complete_input(input).await?;
        return Ok(PrepareOutcome::Completed);
    }
    let session_events = inner.store.list_events(input.session_id, 0).await?;
    let base_system_prompt = inner
        .system_prompt
        .read()
        .unwrap_or_else(|value| value.into_inner())
        .clone();
    let mut context = rebuild_context(&session_events, &base_system_prompt);
    let delivered_notifications = session_events
        .iter()
        .filter(|event| event.event_type == "context.subagent_notification")
        .filter_map(|event| event.payload.get("messageID").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let notifications = inner
        .store
        .pending_agent_messages(input.session_id, "/root")
        .await?;
    for notification in &notifications {
        if delivered_notifications.contains(notification.id.to_string().as_str()) {
            continue;
        }
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "context.subagent_notification",
                json!({
                    "messageID":notification.id,
                    "senderPath":notification.sender_path,
                    "content":notification.content,
                    "details":notification.details,
                }),
            )
            .await?;
        context.messages.push(
            serde_json::from_value(json!({
                "role":"custom",
                "customType":"subagentNotification",
                "content":notification.content,
                "display":false,
                "timestamp":notification.created_at,
            }))
            .map_err(StoreError::from)?,
        );
    }
    inner
        .store
        .consume_agent_messages(
            &notifications
                .iter()
                .map(|notification| notification.id)
                .collect::<Vec<_>>(),
        )
        .await?;
    let session = inner.store.get_session(input.session_id).await?;
    let runtime_participants = if session.participants.is_empty() {
        vec![json!({
            "assistantId":"runtime-default",
            "assistantName":"Eden Agent",
            "characterId":"runtime-default",
            "characterName":"Eden Agent",
        })]
    } else {
        session.participants.clone()
    };
    let input_text = input
        .payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let internal_handoff = input
        .payload
        .get("internalHandoff")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let memory_candidates = if let Some(character_id) =
        prompt::primary_character_id(&runtime_participants)
    {
        inner
            .store
            .search_memories_in_scope("agent_character", &character_id, None, 100)
            .await
            .unwrap_or_else(|error| {
                warn!(%error, session_id = %input.session_id, turn_id = %input.turn_id, "long-term memory recall failed; continuing without memories");
                Vec::new()
            })
    } else {
        Vec::new()
    };
    let memories = prompt::select_relevant_memories(
        &runtime_participants,
        &memory_candidates,
        &input_text,
        5,
        4_000,
    );
    let recent_character_actions = prompt::select_recent_character_actions(
        &session_events,
        prompt::primary_character_id(&runtime_participants).as_deref(),
        5,
    );
    let prompt_profile =
        if input.payload.get("jobKind").and_then(Value::as_str) == Some("self_awake") {
            prompt::PromptProfile::SelfAwake
        } else {
            prompt::PromptProfile::UserChat
        };
    let self_awake_state = if prompt_profile == prompt::PromptProfile::SelfAwake {
        let job_id = input
            .payload
            .get("jobId")
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| AgentError::Hook("self-awake input has no valid jobId".to_owned()))?;
        let job = inner.store.get_job(job_id).await?;
        let diaries = inner
            .store
            .list_self_awake_diaries(input.session_id, 5)
            .await?;
        let request = self_awake::build_request(
            &job,
            &runtime_participants,
            &memory_candidates,
            &diaries,
            &session.environment,
        );
        let author_snapshot = self_awake::author_snapshot(&request);
        let request_value = self_awake::to_value(&request);
        let run = inner
            .store
            .start_self_awake_run(
                &job,
                self_awake::SCHEMA_VERSION,
                self_awake::event_id(&request),
                request_value.clone(),
                author_snapshot.clone(),
            )
            .await?;
        if run.status == "completed" {
            inner.store.complete_job(job.id).await?;
            inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "self_awake.recovered",
                    json!({"runId":run.id,"jobId":job.id,"resolution":"already_completed"}),
                )
                .await?;
            inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "turn.completed",
                    json!({"recovered":true,"selfAwakeRunId":run.id}),
                )
                .await?;
            inner.store.complete_input(input).await?;
            return Ok(PrepareOutcome::Completed);
        }
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "self_awake.started",
                json!({
                    "runId":run.id,
                    "jobId":job.id,
                    "schemaVersion":self_awake::SCHEMA_VERSION,
                    "eventId":self_awake::event_id(&request),
                    "author":author_snapshot,
                    "attempt":run.attempts,
                }),
            )
            .await?;
        Some((job, run, request))
    } else {
        None
    };
    let effective_text = self_awake_state
        .as_ref()
        .map(|(_, _, request)| self_awake::task_prompt(request))
        .unwrap_or_else(|| input_text.to_owned());
    context.system_prompt = prompt::compile_system_prompt(
        &base_system_prompt,
        &runtime_participants,
        &memories,
        &recent_character_actions,
        &session.environment,
        prompt_profile,
    );
    context.metadata = json!({
        "sessionId": input.session_id,
        "turnId": input.turn_id,
        "inputId": input.id,
        "operationId": input.id,
        "primaryAssistantId": prompt::primary_assistant_id(&runtime_participants),
        "primaryCharacterId": prompt::primary_character_id(&runtime_participants),
        "currentSpeakerNames": prompt::primary_speaker_names(&runtime_participants),
        "memoryIds": memories.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        "attachments": input.payload.get("attachments").cloned().unwrap_or_else(|| json!([])),
        "promptProfile": if prompt_profile == prompt::PromptProfile::SelfAwake { "self_awake" } else { "user_chat" },
    });
    let prompt = build_user_message(inner.blobs.as_ref(), &input.payload, &effective_text).await?;
    let prompt = inner
        .model
        .prepare_user_message(Some(&session_key), prompt, cancellation.child_token())
        .await?;
    let directed =
        session.participants.len() > 1 && prompt_profile == prompt::PromptProfile::UserChat;
    let conversation_context = director_conversation_context(&session_events, 12_000);
    let attachments = attachment_summary(&input.payload);
    let plan = director::create_plan(director::DirectorRequest {
        model: Arc::clone(&inner.model),
        model_spec: &active_model_spec,
        session_id: &session_key,
        user_text: &effective_text,
        participants: &runtime_participants,
        conversation_context: &conversation_context,
        attachment_context: &attachments,
        cancellation: cancellation.child_token(),
    })
    .await;
    if directed {
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "companion.director.started",
                json!({
                    "sessionID":input.session_id,
                    "participantCount":session.participants.len(),
                    "userMessageID":input.id,
                }),
            )
            .await?;
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "companion.plan",
                json!({
                    "sessionID":input.session_id,
                    "planID":plan.plan_id,
                    "userMessageID":input.id,
                    "source":plan.source,
                    "diagnostic":plan.diagnostic,
                    "scene":plan.scene,
                    "execution":plan.execution,
                    "beats":plan.beats,
                    "status":"planned",
                }),
            )
            .await?;
    }
    Ok(PrepareOutcome::Ready(Box::new(PreparedTurn {
        active_model_spec,
        session_participants: session.participants,
        session_environment: session.environment,
        session_events,
        runtime_participants,
        input_text,
        internal_handoff,
        prompt_profile,
        self_awake_state,
        effective_text,
        context,
        prompt,
        plan,
        directed,
    })))
}
