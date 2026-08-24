use super::super::context::{
    RuntimeLoopHooks, latest_prompt_cache_states, latest_skill_snapshots, prompt_section,
    skill_prompt_section,
};
use super::super::event::{annotate_agent_event, persist_agent_event};
use super::super::tool_policy::tools_for_profile;
use super::super::{EVENT_CHANNEL_CAPACITY, RuntimeError, RuntimeInner};
use crate::{director, prompt};
use eden_agent_core::{
    AgentContext, AgentError, AgentLoop, AgentLoopConfig, LoopControl, Message, ModelSpec,
    advance_prompt_prefix, estimate_prompt_token_breakdown, event_channel, prompt_prefix_state,
};
use eden_agent_store::{EventRecord, InputRecord, StoreError};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::warn;

pub(super) struct DirectedTurnResult {
    pub(super) new_messages: Vec<Message>,
    pub(super) turns: u32,
}

pub(super) struct ExecutionRequest<'a> {
    pub(super) inner: &'a Arc<RuntimeInner>,
    pub(super) input: &'a InputRecord,
    pub(super) base_context: AgentContext,
    pub(super) user_prompt: Message,
    pub(super) participants: &'a [Value],
    pub(super) session_events: &'a [EventRecord],
    pub(super) plan: &'a director::DirectorPlan,
    pub(super) user_text: &'a str,
    pub(super) session_environment: &'a Value,
    pub(super) prompt_profile: prompt::PromptProfile,
    pub(super) model_spec: &'a ModelSpec,
    pub(super) directed: bool,
    pub(super) cancellation: CancellationToken,
    pub(super) control: LoopControl,
}

pub(super) async fn execute_director_plan(
    request: ExecutionRequest<'_>,
) -> Result<DirectedTurnResult, RuntimeError> {
    let ExecutionRequest {
        inner,
        input,
        base_context,
        user_prompt,
        participants,
        session_events,
        plan,
        user_text,
        session_environment,
        prompt_profile,
        model_spec,
        directed,
        cancellation,
        control,
    } = request;
    if participants.is_empty() {
        return Err(AgentError::Hook("当前会话没有可用的参与助手".to_owned()).into());
    }
    let mut conversation_messages = base_context.messages;
    let mut all_new_messages = Vec::new();
    let mut total_turns = 0;
    let mut previous_speakers = Vec::new();
    let mut cache_states = latest_prompt_cache_states(session_events);
    let mut skill_snapshots = latest_skill_snapshots(session_events);
    let session_key = input.session_id.to_string();
    let assistant_handoff_intent = prompt_profile == prompt::PromptProfile::UserChat
        && prompt::requests_assistant_handoff(user_text);
    let profile_tools = tools_for_profile(&inner.tools, prompt_profile);
    let profile_tools = if assistant_handoff_intent {
        profile_tools.only(["list_assistants", "switch_session_assistant"])
    } else {
        profile_tools
    };
    for (beat_index, beat) in plan.beats.iter().enumerate() {
        let beat_id = director::participant_id_value_for_runtime(&beat.assistant_id);
        let participant = participants
            .iter()
            .find(|participant| {
                director::participant_id(participant).as_deref() == beat_id.as_deref()
            })
            .ok_or_else(|| {
                AgentError::Hook(format!("导演选择了未知助手: {}", beat.assistant_id))
            })?;
        let speaker = director::public_participant(participant, beat_index);
        let orchestration = if directed {
            json!({
                "planID":plan.plan_id,
                "directorSource":plan.source,
                "directorDiagnostic":plan.diagnostic,
                "scene":plan.scene,
                "execution":plan.execution,
                "beatIndex":beat_index,
                "speechAct":beat.speech_act,
                "addressTo":beat.address_to,
                "replyToBeat":beat.reply_to_beat,
                "intent":beat.intent,
            })
        } else {
            json!({})
        };
        if directed {
            inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "companion.speaker.started",
                    json!({
                        "sessionID":input.session_id,
                        "planID":plan.plan_id,
                        "beatIndex":beat_index,
                        "speaker":speaker,
                        "beat":beat,
                    }),
                )
                .await?;
        }
        let actor_participants = vec![participant.clone()];
        let character_id = prompt::primary_character_id(&actor_participants);
        let memory_candidates = if let Some(character_id) = character_id.as_deref() {
            inner
                .store
                .search_memories_in_scope("agent_character", character_id, None, 100)
                .await
                .unwrap_or_else(|error| {
                    warn!(%error, session_id = %input.session_id, turn_id = %input.turn_id, assistant_id = ?beat.assistant_id, "actor memory recall failed; continuing without memories");
                    Vec::new()
                })
        } else {
            Vec::new()
        };
        let memories = prompt::select_relevant_memories(
            &actor_participants,
            &memory_candidates,
            user_text,
            5,
            4_000,
        );
        let actions =
            prompt::select_recent_character_actions(session_events, character_id.as_deref(), 5);
        let base_system_prompt = inner
            .system_prompt
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let mut actor_context = AgentContext {
            system_prompt: prompt::compile_system_prompt(
                &base_system_prompt,
                &actor_participants,
                &memories,
                &actions,
                session_environment,
                prompt_profile,
            ),
            messages: conversation_messages.clone(),
            metadata: json!({
                "sessionId":input.session_id,
                "turnId":input.turn_id,
                "inputId":input.id,
                "operationId":input.id,
                "primaryAssistantId":prompt::primary_assistant_id(&actor_participants),
                "primaryCharacterId":character_id,
                "currentSpeakerNames":prompt::primary_speaker_names(&actor_participants),
                "memoryIds":memories.iter().map(|memory|memory.id).collect::<Vec<_>>(),
                "attachments":input.payload.get("attachments").cloned().unwrap_or_else(|| json!([])),
                "speaker":speaker,
                "orchestration":orchestration,
                "promptProfile":if prompt_profile == prompt::PromptProfile::SelfAwake { "self_awake" } else { "user_chat" },
            }),
        };
        if assistant_handoff_intent {
            actor_context.system_prompt.push_str("\n\n");
            actor_context
                .system_prompt
                .push_str(prompt::assistant_handoff_turn_constraint());
            if let Some(metadata) = actor_context.metadata.as_object_mut() {
                metadata.insert("assistantHandoffIntent".to_owned(), json!(true));
                metadata.insert(
                    "assistantHandoffAllowedTools".to_owned(),
                    json!(["list_assistants", "switch_session_assistant"]),
                );
            }
        }
        actor_context.messages.push(
            serde_json::from_value(json!({
                "role":"custom",
                "customType":"runtimeEnvironment",
                "content":prompt::runtime_environment_context(session_environment),
                "display":false,
                "timestamp":eden_agent_core::now_ms(),
            }))
            .map_err(StoreError::from)?,
        );
        let actor_model_spec = inner
            .model
            .model_spec_for_actor(
                Some(&session_key),
                director::participant_id(participant).as_deref(),
            )
            .await
            .unwrap_or_else(|| model_spec.clone());
        let actor_key = prompt::primary_assistant_id(&actor_participants)
            .unwrap_or_else(|| "runtime-default".to_owned());
        let current_skill_snapshot = skill_prompt_section(&actor_context.system_prompt).trim();
        if !current_skill_snapshot.is_empty()
            && skill_snapshots.get(&actor_key).map(String::as_str) != Some(current_skill_snapshot)
        {
            let snapshot_id = uuid::Uuid::now_v7().to_string();
            let snapshot_content = format!(
                "<active_skill_snapshot id={snapshot_id:?}>\n{current_skill_snapshot}\n</active_skill_snapshot>"
            );
            actor_context.messages.push(
                serde_json::from_value(json!({
                    "role":"custom",
                    "customType":"skillSnapshot",
                    "snapshotID":snapshot_id,
                    "assistantID":actor_key,
                    "content":snapshot_content,
                    "display":false,
                    "timestamp":eden_agent_core::now_ms(),
                }))
                .map_err(StoreError::from)?,
            );
            inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "context.skill_snapshot",
                    json!({
                        "snapshotID":snapshot_id,
                        "assistantId":actor_key,
                        "content":snapshot_content,
                        "display":false,
                    }),
                )
                .await?;
            skill_snapshots.insert(actor_key.clone(), current_skill_snapshot.to_owned());
        }
        let tool_definitions = profile_tools.direct_definitions();
        let current_cache = prompt_prefix_state(
            &actor_model_spec,
            &actor_context.system_prompt,
            &tool_definitions,
        );
        let mut cache_state = advance_prompt_prefix(cache_states.get(&actor_key), current_cache);
        let prompt_cache_key = format!("{}:{}", input.session_id, actor_key);
        cache_state["sessionKey"] = json!(prompt_cache_key);
        cache_states.insert(actor_key.clone(), cache_state.clone());
        let token_breakdown = estimate_prompt_token_breakdown(
            &actor_context.system_prompt,
            prompt_section(&actor_context.system_prompt, "# 身份"),
            skill_prompt_section(&actor_context.system_prompt),
            &tool_definitions,
            &actor_context.messages,
            Some(&actor_model_spec.id),
        );
        if let Some(metadata) = actor_context.metadata.as_object_mut() {
            metadata.insert("promptCache".to_owned(), cache_state.clone());
            metadata.insert("promptCacheKey".to_owned(), json!(prompt_cache_key));
            metadata.insert(
                "promptCacheFingerprint".to_owned(),
                cache_state
                    .get("fingerprint")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            metadata.insert(
                "promptCacheEpoch".to_owned(),
                cache_state
                    .get("epoch")
                    .cloned()
                    .unwrap_or_else(|| json!(0)),
            );
            metadata.insert(
                "tokenBreakdown".to_owned(),
                serde_json::to_value(token_breakdown).unwrap_or_else(|_| json!({})),
            );
        }
        inner
            .store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                "context.cache_state",
                json!({
                    "assistantId":actor_key,
                    "modelId":actor_model_spec.id,
                    "cache":cache_state,
                    "tokenBreakdown":token_breakdown,
                }),
            )
            .await?;
        let mut config = AgentLoopConfig::new(actor_model_spec.clone(), Arc::clone(&inner.model));
        config.tools = profile_tools.clone();
        config.hooks = Arc::clone(&inner.hooks);
        let loop_hooks = Arc::new(RuntimeLoopHooks::new(
            inner,
            &profile_tools,
            actor_model_spec,
            input.session_id,
            input.turn_id,
            actor_key,
        ));
        config.loop_hooks = loop_hooks.clone();
        config.session_id = Some(input.session_id.to_string());
        let driver = AgentLoop::new(config);
        let (emitter, mut events) = event_channel(EVENT_CHANNEL_CAPACITY);
        let first_beat = beat_index == 0;
        if !first_beat {
            actor_context
                .messages
                .push(Message::user(director::actor_task_prompt(
                    user_text,
                    beat,
                    &plan.scene,
                    &plan.execution,
                    &previous_speakers,
                )));
        }
        let execution = async {
            if first_beat {
                driver
                    .run(
                        vec![user_prompt.clone()],
                        actor_context,
                        control.clone(),
                        cancellation.child_token(),
                        emitter,
                    )
                    .await
            } else {
                driver
                    .continue_from(
                        actor_context,
                        control.clone(),
                        cancellation.child_token(),
                        emitter,
                    )
                    .await
            }
        };
        let persistence = async {
            let mut active_message_id = None;
            while let Some(event) = events.recv().await {
                // Speaker identity is message metadata, not director-only metadata.
                // Persist it for single-participant turns too so voice output and
                // historical rendering can resolve the participant's TTS config.
                let event = annotate_agent_event(event, &speaker, &orchestration);
                persist_agent_event(&inner.store, input, event, &mut active_message_id).await?;
            }
            Ok::<(), RuntimeError>(())
        };
        let (execution_result, persistence_result) = tokio::join!(execution, persistence);
        persistence_result?;
        let result = execution_result?;
        loop_hooks
            .persist_completed_context(
                result
                    .new_messages
                    .iter()
                    .rev()
                    .find(|message| matches!(message, Message::Assistant(_))),
            )
            .await?;
        total_turns += result.turns;
        conversation_messages.extend(result.new_messages.iter().cloned());
        all_new_messages.extend(result.new_messages);
        previous_speakers.push(speaker.clone());
        if directed {
            inner
                .store
                .append_event(
                    input.session_id,
                    Some(input.turn_id),
                    "companion.speaker.finished",
                    json!({
                        "sessionID":input.session_id,
                        "planID":plan.plan_id,
                        "beatIndex":beat_index,
                        "speaker":speaker,
                    }),
                )
                .await?;
        }
    }
    Ok(DirectedTurnResult {
        new_messages: all_new_messages,
        turns: total_turns,
    })
}
