use super::*;

pub(crate) fn store_origin(origin: RuntimeOrigin) -> SessionRuntimeOrigin {
    match origin {
        RuntimeOrigin::Mon => SessionRuntimeOrigin::Mon,
        RuntimeOrigin::Local => SessionRuntimeOrigin::Local,
    }
}

pub(crate) fn session_origin(session: &SessionRecord) -> RuntimeOrigin {
    match session.runtime_origin {
        SessionRuntimeOrigin::Mon => RuntimeOrigin::Mon,
        SessionRuntimeOrigin::Local => RuntimeOrigin::Local,
    }
}

pub(crate) fn require_mon_origin(origin: RuntimeOrigin, method: &str) -> Result<(), RpcFailure> {
    if origin == RuntimeOrigin::Mon {
        return Ok(());
    }
    Err(RpcFailure::application(format!(
        "runtime_origin_unsupported: {method} requires the Mon runtime"
    )))
}

pub(crate) async fn enforce_request_origin(
    state: &AppState,
    origin: RuntimeOrigin,
    method: &str,
    params: &Value,
) -> Result<(), RpcFailure> {
    if matches!(method, "session.create" | "session.list") {
        return Ok(());
    }
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        return Ok(());
    };
    let session_id = session_id
        .parse::<SessionId>()
        .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
    let session = state
        .store
        .get_session(session_id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    if session_origin(&session) == origin {
        return Ok(());
    }
    Err(RpcFailure::application(
        "runtime_origin_mismatch: session is not available in this runtime",
    ))
}

pub(crate) async fn session_is_visible(
    state: &AppState,
    origin: RuntimeOrigin,
    session_id: SessionId,
) -> bool {
    state
        .store
        .get_session(session_id)
        .await
        .is_ok_and(|session| session_origin(&session) == origin)
}

pub(crate) fn project_director_runs(events: Vec<EventRecord>) -> Vec<DirectorRunInfo> {
    #[derive(Clone)]
    struct StartedInfo {
        participant_count: Option<u32>,
        user_message_id: Option<String>,
        created_at: i64,
    }

    let mut started_by_turn = HashMap::<String, StartedInfo>::new();
    let mut run_index = HashMap::<String, usize>::new();
    let mut runs = Vec::<DirectorRunInfo>::new();

    for event in events {
        let turn_key = event.turn_id.map(|turn_id| turn_id.to_string());
        match event.event_type.as_str() {
            "companion.director.started" => {
                if let Some(turn_key) = turn_key {
                    started_by_turn.insert(
                        turn_key,
                        StartedInfo {
                            participant_count: event
                                .payload
                                .get("participantCount")
                                .and_then(Value::as_u64)
                                .and_then(|value| u32::try_from(value).ok()),
                            user_message_id: event
                                .payload
                                .get("userMessageID")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            created_at: event.created_at,
                        },
                    );
                }
            }
            "companion.plan" => {
                let Some(plan_id) = event
                    .payload
                    .get("planID")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    continue;
                };
                let started = turn_key
                    .as_ref()
                    .and_then(|turn_key| started_by_turn.get(turn_key));
                let scene = event
                    .payload
                    .get("scene")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<DirectorSceneInfo>(value).ok());
                let execution =
                    event.payload.get("execution").cloned().and_then(|value| {
                        serde_json::from_value::<DirectorExecutionInfo>(value).ok()
                    });
                let beats = event
                    .payload
                    .get("beats")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<Vec<DirectorBeatInfo>>(value).ok())
                    .unwrap_or_default();
                let run = DirectorRunInfo {
                    plan_id: plan_id.clone(),
                    user_message_id: event
                        .payload
                        .get("userMessageID")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| started.and_then(|value| value.user_message_id.clone())),
                    source: event
                        .payload
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned(),
                    diagnostic: event
                        .payload
                        .get("diagnostic")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    scene,
                    execution,
                    beats,
                    status: DirectorRunStatus::Planned,
                    active_beat_index: None,
                    completed_beat_indexes: Vec::new(),
                    participant_count: started.and_then(|value| value.participant_count),
                    error: None,
                    created_at: started.map_or(event.created_at, |value| value.created_at),
                    updated_at: event.created_at,
                };
                if let Some(index) = run_index.get(&plan_id).copied() {
                    runs[index] = run;
                } else {
                    run_index.insert(plan_id, runs.len());
                    runs.push(run);
                }
            }
            "companion.speaker.started" | "companion.speaker.finished" => {
                let Some(run) = event
                    .payload
                    .get("planID")
                    .and_then(Value::as_str)
                    .and_then(|plan_id| run_index.get(plan_id).copied())
                    .and_then(|index| runs.get_mut(index))
                else {
                    continue;
                };
                let Some(beat_index) = event
                    .payload
                    .get("beatIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                else {
                    continue;
                };
                run.status = DirectorRunStatus::Running;
                if event.event_type == "companion.speaker.started" {
                    run.active_beat_index = Some(beat_index);
                } else {
                    run.active_beat_index = None;
                    if !run.completed_beat_indexes.contains(&beat_index) {
                        run.completed_beat_indexes.push(beat_index);
                        run.completed_beat_indexes.sort_unstable();
                    }
                }
                run.updated_at = event.created_at;
            }
            "companion.director.completed" | "companion.director.failed" => {
                let Some(run) = event
                    .payload
                    .get("planID")
                    .and_then(Value::as_str)
                    .and_then(|plan_id| run_index.get(plan_id).copied())
                    .and_then(|index| runs.get_mut(index))
                else {
                    continue;
                };
                run.status = if event.event_type == "companion.director.completed" {
                    DirectorRunStatus::Completed
                } else {
                    DirectorRunStatus::Failed
                };
                run.active_beat_index = None;
                if let Some(indexes) = event
                    .payload
                    .get("completedBeatIndexes")
                    .and_then(Value::as_array)
                {
                    run.completed_beat_indexes = indexes
                        .iter()
                        .filter_map(Value::as_u64)
                        .filter_map(|value| u32::try_from(value).ok())
                        .collect();
                    run.completed_beat_indexes.sort_unstable();
                    run.completed_beat_indexes.dedup();
                }
                run.error = event
                    .payload
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                run.updated_at = event.created_at;
            }
            _ => {}
        }
    }
    runs.sort_by_key(|run| run.created_at);
    runs
}

pub(crate) async fn ensure_session_model_mutable(
    state: &AppState,
    session_id: SessionId,
) -> Result<(), RpcFailure> {
    if state
        .store
        .session_has_active_work(session_id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
    {
        return Err(RpcFailure::application(
            "当前会话仍有排队或运行中的回合/子智能体，请等待完成或先取消，再修改参与者或模型",
        ));
    }
    Ok(())
}

pub(crate) async fn configure_session_actor_models(
    state: &AppState,
    session_id: SessionId,
    core_base_url: &str,
    core_token: &str,
) -> Result<Vec<Value>, RpcFailure> {
    let session = state
        .store
        .get_session(session_id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    let mut actors = Vec::new();
    for participant in &session.participants {
        let Some(assistant_id) = participant
            .get("assistantId")
            .filter(|value| !value.is_null())
        else {
            continue;
        };
        let actor = state
            .core_models
            .configure_assistant_for_session(
                core_base_url,
                core_token,
                assistant_id,
                &session_id.to_string(),
                &state.models,
            )
            .await
            .map_err(|error| RpcFailure::application(error.to_string()))?;
        let main_id = actor
            .get("main")
            .and_then(|value| value.get("aiEntityId"))
            .map(|value| json_id(Some(value)))
            .unwrap_or_default();
        let vision_id = actor
            .get("vision")
            .and_then(|value| value.get("aiEntityId"))
            .map(|value| json_id(Some(value)));
        state
            .store
            .set_session_actor_model_binding(
                session_id,
                &json_id(Some(assistant_id)),
                &main_id,
                vision_id.as_deref(),
                actor.get("main").cloned().unwrap_or_else(|| json!({})),
            )
            .await
            .map_err(|error| RpcFailure::application(error.to_string()))?;
        actors.push(actor);
    }
    state
        .store
        .append_event(
            session_id,
            None,
            "session.actor_models.bound",
            json!({"actors":actors}),
        )
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    Ok(actors)
}

pub(crate) async fn session_model_identity(
    state: &AppState,
    session_id: Option<SessionId>,
) -> Result<(Option<Value>, Option<Value>), RpcFailure> {
    let Some(session_id) = session_id else {
        return Ok((None, None));
    };
    let session = state
        .store
        .get_session(session_id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    let participant = session.participants.first();
    let assistant_id = participant
        .and_then(|value| value.get("assistantId"))
        .cloned();
    let vision_ai_entity_id = participant
        .and_then(|value| value.get("profile"))
        .and_then(|value| value.get("character"))
        .and_then(|value| {
            value
                .get("vision_ai_entity_id")
                .or_else(|| value.get("visionAiEntityId"))
        })
        .filter(|value| !value.is_null())
        .cloned();
    Ok((assistant_id, vision_ai_entity_id))
}

pub(crate) async fn persist_session_model_binding(
    state: &AppState,
    session_id: SessionId,
    assistant_id: Option<&Value>,
    vision_ai_entity_id: Option<&Value>,
    catalog: &Value,
) -> Result<(), RpcFailure> {
    let Some(ai_entity_id) = catalog
        .get("current")
        .and_then(|value| value.get("aiEntityId"))
        .filter(|value| !value.is_null())
    else {
        return Ok(());
    };
    let session_key = session_id.to_string();
    let runtime_info = state.models.runtime_info_for(Some(&session_key)).await;
    let vision_ai_entity_id = catalog
        .get("vision")
        .and_then(|value| value.get("aiEntityId"))
        .filter(|value| !value.is_null())
        .or(vision_ai_entity_id)
        .map(|value| json_id(Some(value)));
    let binding = state
        .store
        .set_session_model_binding(
            session_id,
            &json_id(assistant_id),
            &json_id(Some(ai_entity_id)),
            vision_ai_entity_id.as_deref(),
            runtime_info,
        )
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    state
        .store
        .append_event(
            session_id,
            None,
            "session.model.bound",
            serde_json::to_value(binding)
                .map_err(|error| RpcFailure::application(error.to_string()))?,
        )
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    Ok(())
}

pub(crate) fn json_id(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => String::new(),
    }
}

pub(crate) async fn workspace_target(
    root: &std::path::Path,
    relative: &str,
) -> Result<(PathBuf, PathBuf), RpcFailure> {
    let root = fs::canonicalize(root)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    let candidate = root.join(relative.trim_start_matches(['/', '\\']));
    let target = fs::canonicalize(candidate)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    if !target.starts_with(&root) {
        return Err(RpcFailure::application("path is outside workspace"));
    }
    Ok((root, target))
}

pub(crate) fn memo_info(memo: eden_agent_store::MemoRecord) -> MemoInfo {
    MemoInfo {
        id: memo.id,
        title: memo.title,
        content: memo.content,
        kind: memo.kind,
        status: memo.status,
        priority: memo.priority,
        remind_at: memo.remind_at,
        due_at: memo.due_at,
        repeat_rule: memo.repeat_rule,
        related_session_id: memo.related_session_id,
        last_triggered_at: memo.last_triggered_at,
        completed_at: memo.completed_at,
        metadata: memo.metadata,
        created_at: memo.created_at,
        updated_at: memo.updated_at,
    }
}

pub(crate) fn connector_info(connector: eden_agent_store::ConnectorRecord) -> ConnectorInfo {
    ConnectorInfo {
        id: connector.id.to_string(),
        connector_key: connector.connector_key,
        identity_key: connector.identity_key,
        display_name: connector.display_name,
        desired_state: connector.desired_state,
        runtime_state: connector.runtime_state,
        settings: connector.settings,
        last_error: connector.last_error,
        created_at: connector.created_at,
        updated_at: connector.updated_at,
    }
}

pub(crate) fn media_info(record: eden_agent_store::MediaRequestRecord) -> MediaRequestInfo {
    MediaRequestInfo {
        id: record.id.to_string(),
        session_id: record.session_id,
        kind: record.kind,
        state: record.state,
        request: record.request,
        created_at: record.created_at,
    }
}

pub(crate) fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, RpcFailure> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params)
        .map_err(|error| RpcFailure::invalid_params(format!("invalid params: {error}")))
}

pub(crate) fn session_summary(record: SessionRecord) -> SessionSummary {
    let runtime_origin = session_origin(&record);
    let participants = record
        .participants
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();
    let context_tokens = record
        .context_usage
        .as_ref()
        .and_then(|usage| usage.get("contextTokens"))
        .and_then(Value::as_u64);
    let token_breakdown = record
        .context_usage
        .as_ref()
        .and_then(|usage| usage.get("tokenBreakdown"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok());
    SessionSummary {
        id: record.id,
        title: record.title,
        title_source: record.title_source,
        status: match record.status {
            eden_agent_store::SessionStatus::Active => SessionStatus::Active,
            eden_agent_store::SessionStatus::Closed => SessionStatus::Closed,
        },
        runtime_origin,
        participants,
        environment: serde_json::from_value::<SessionEnvironment>(record.environment).ok(),
        context_tokens,
        token_breakdown,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

pub(crate) fn session_event(event: eden_agent_store::EventRecord) -> SessionEvent {
    SessionEvent {
        id: event.id.to_string(),
        session_id: event.session_id,
        seq: event.seq,
        turn_id: event.turn_id,
        event_type: event.event_type,
        payload: event.payload,
        created_at: event.created_at,
    }
}

pub(crate) fn permission_info(
    permission: eden_agent_store::PermissionRecord,
) -> PermissionRequestInfo {
    PermissionRequestInfo {
        id: permission.id,
        session_id: permission.session_id,
        turn_id: permission.turn_id,
        operation_id: permission.operation_id,
        capability: permission.capability,
        resource: permission.resource,
        state: match permission.state {
            eden_agent_store::PermissionState::Pending => "pending",
            eden_agent_store::PermissionState::Allowed => "allowed",
            eden_agent_store::PermissionState::Denied => "denied",
            eden_agent_store::PermissionState::Expired => "expired",
        }
        .to_owned(),
        request: permission.request,
        created_at: permission.created_at,
    }
}

pub(crate) fn operation_info(operation: eden_agent_store::OperationJournalRecord) -> OperationInfo {
    OperationInfo {
        operation_id: operation.operation_id,
        session_id: operation.session_id,
        turn_id: operation.turn_id,
        tool_call_id: operation.tool_call_id,
        tool_name: operation.tool_name,
        capability: operation.capability,
        resource: operation.resource,
        state: operation.state,
        request: operation.request,
        result: operation.result,
        error: operation.error,
        created_at: operation.created_at,
        updated_at: operation.updated_at,
    }
}

pub(crate) fn question_info(
    question: eden_agent_store::QuestionRecord,
) -> Result<QuestionRequestInfo, RpcFailure> {
    let questions = serde_json::from_value(question.questions).map_err(|error| {
        RpcFailure::application(format!("invalid stored question payload: {error}"))
    })?;
    Ok(QuestionRequestInfo {
        id: question.id,
        session_id: question.session_id,
        turn_id: question.turn_id,
        state: match question.state {
            eden_agent_store::QuestionState::Pending => "pending",
            eden_agent_store::QuestionState::Answered => "answered",
            eden_agent_store::QuestionState::Rejected => "rejected",
            eden_agent_store::QuestionState::Expired => "expired",
        }
        .to_owned(),
        questions,
        created_at: question.created_at,
    })
}

pub(crate) fn agent_info(
    agent: eden_agent_store::AgentThreadRecord,
) -> Result<AgentThreadInfo, RpcFailure> {
    let status = match agent.status.as_str() {
        "queued" => AgentThreadStatus::Queued,
        "running" => AgentThreadStatus::Running,
        "completed" => AgentThreadStatus::Completed,
        "failed" => AgentThreadStatus::Failed,
        "interrupted" => AgentThreadStatus::Interrupted,
        value => {
            return Err(RpcFailure::application(format!(
                "invalid stored agent status: {value}"
            )));
        }
    };
    let result = agent
        .result
        .map(serde_json::from_value::<AgentThreadResultInfo>)
        .transpose()
        .map_err(|error| {
            RpcFailure::application(format!("invalid stored agent result: {error}"))
        })?;
    Ok(AgentThreadInfo {
        id: agent.id,
        session_id: agent.session_id,
        parent_id: agent.parent_id,
        agent_path: agent.agent_path,
        task_name: agent.task_name,
        role: agent.role,
        status,
        result,
        error: agent.error,
        created_at: agent.created_at,
        updated_at: agent.updated_at,
        started_at: agent.started_at,
        completed_at: agent.completed_at,
        config: agent.config,
        usage: agent.usage,
        deadline_at: agent.deadline_at,
        coordination_batch_id: agent.coordination_batch_id,
    })
}
