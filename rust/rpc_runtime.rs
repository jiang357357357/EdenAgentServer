use super::*;

pub(crate) async fn execute_runtime_rpc(
    state: &AppState,
    runtime_origin: RuntimeOrigin,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "agent.list" => {
            let params: AgentListParams = parse_params(params)?;
            let agents = state
                .multiagents
                .list(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .map(agent_info)
                .collect::<Result<Vec<_>, _>>()?;
            serde_json::to_value(agents).map_err(|error| RpcFailure::application(error.to_string()))
        }
        "agent.read" => {
            let params: AgentReadParams = parse_params(params)?;
            let agent = state
                .store
                .get_agent_thread(params.agent_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if !session_is_visible(state, runtime_origin, agent.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: agent is not available in this runtime",
                ));
            }
            serde_json::to_value(agent_info(agent)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "agent.interrupt" => {
            let params: AgentReadParams = parse_params(params)?;
            let record = state
                .store
                .get_agent_thread(params.agent_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: agent is not available in this runtime",
                ));
            }
            let agent = state
                .multiagents
                .interrupt(params.agent_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(agent_info(agent)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "agent.send" | "agent.followup" => {
            let followup = method == "agent.followup";
            let params: AgentMessageParams = parse_params(params)?;
            let record = state
                .store
                .get_agent_thread(params.agent_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if !session_is_visible(state, runtime_origin, record.session_id).await {
                return Err(RpcFailure::application(
                    "runtime_origin_mismatch: agent is not available in this runtime",
                ));
            }
            let agent = state
                .multiagents
                .send_message(params.agent_id, &params.message, followup)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(agent_info(agent)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "memo.list" => {
            let params: MemoListParams = parse_params(params)?;
            let memos = state
                .store
                .list_memos(params.limit, params.query.as_deref())
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(memos.into_iter().map(memo_info).collect::<Vec<_>>())
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "memo.create" => {
            let params: MemoCreateParams = parse_params(params)?;
            let memo = state
                .store
                .create_memo(eden_agent_store::MemoInput {
                    title: params.title,
                    content: params.content,
                    kind: params.kind,
                    status: params.status,
                    priority: params.priority,
                    remind_at: params.remind_at,
                    due_at: params.due_at,
                    repeat_rule: params.repeat_rule,
                    source: "edenagent".to_owned(),
                    related_session_id: params.related_session_id,
                    metadata: params.metadata,
                })
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if let Some(due_at) = memo.remind_at.or(memo.due_at) {
                state
                    .store
                    .schedule_job(
                        "memo.reminder",
                        memo.related_session_id.parse().ok(),
                        due_at,
                        json!({"memoId":memo.id}),
                        &format!("memo:{}", memo.id),
                    )
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            serde_json::to_value(memo_info(memo))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "memo.update" => {
            let params: MemoUpdateParams = parse_params(params)?;
            let memo = state
                .store
                .update_memo(params.id, params.patch)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(memo_info(memo))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "memo.complete" | "memo.archive" => {
            let params: MemoIdParams = parse_params(params)?;
            let status = if method == "memo.complete" {
                "done"
            } else {
                "archived"
            };
            let memo = state
                .store
                .update_memo(params.id, json!({"status":status}))
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(memo_info(memo))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "connector.list" => {
            let connectors = state
                .store
                .list_connectors()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(
                connectors
                    .into_iter()
                    .map(connector_info)
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "connector.catalog" => {
            let catalog =
                serde_json::from_value::<ConnectorCatalogInfo>(state.connectors.catalog_json())
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(catalog)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "connector.create" => {
            let params: ConnectorCreateParams = parse_params(params)?;
            state
                .connectors
                .validate_registration(&params.connector_key, &params.settings)
                .map_err(RpcFailure::invalid_params)?;
            let connector = state
                .store
                .register_connector(
                    &params.connector_key,
                    &params.identity_key,
                    &params.display_name,
                    &params.desired_state,
                    params.settings,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(connector_info(connector))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "connector.update" => {
            let params: ConnectorUpdateParams = parse_params(params)?;
            let id = Uuid::parse_str(&params.id)
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            if let Some(settings) = params.patch.get("settings") {
                let current = state
                    .store
                    .get_connector(id)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
                state
                    .connectors
                    .validate_registration(&current.connector_key, settings)
                    .map_err(RpcFailure::invalid_params)?;
            }
            let connector = state
                .store
                .update_connector(id, params.patch)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(connector_info(connector))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "workspace.info" => {
            let workspace_state = state
                .workspaces
                .state()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let root = state.workspaces.current_root();
            serde_json::to_value(WorkspaceInfo {
                name: root
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("workspace")
                    .to_owned(),
                path: root.to_string_lossy().into_owned(),
                pending_path: workspace_state.pending_path,
                requested_at: workspace_state.requested_at,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "workspace.switch" => {
            let params: WorkspaceSwitchParams = parse_params(params)?;
            let path = params.path.trim();
            if path.is_empty() {
                return Err(RpcFailure::invalid_params("path is required"));
            }
            let workspace_state = state
                .workspaces
                .request_switch(params.session_id, path)
                .await
                .map_err(RpcFailure::invalid_params)?;
            serde_json::to_value(workspace_state)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "workspace.list" => {
            let params: WorkspacePathParams = parse_params(params)?;
            let relative = params.path.as_str();
            let workspace_root = state.workspaces.current_root();
            let (root, target) = workspace_target(&workspace_root, relative).await?;
            let mut reader = fs::read_dir(&target)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut entries = Vec::new();
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
            {
                let metadata = entry
                    .metadata()
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
                let path = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(&entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                entries.push(WorkspaceEntryInfo {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path,
                    entry_type: if metadata.is_dir() {
                        WorkspaceEntryKind::Directory
                    } else {
                        WorkspaceEntryKind::File
                    },
                    size: metadata.is_file().then_some(metadata.len()),
                });
            }
            entries.sort_by(|left, right| {
                matches!(left.entry_type, WorkspaceEntryKind::File)
                    .cmp(&matches!(right.entry_type, WorkspaceEntryKind::File))
                    .then_with(|| left.name.cmp(&right.name))
            });
            serde_json::to_value(WorkspaceDirectoryInfo {
                root: root.to_string_lossy().into_owned(),
                path: relative.to_owned(),
                entries,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "workspace.read" => {
            let params: WorkspacePathParams = parse_params(params)?;
            let relative = params.path.trim();
            if relative.is_empty() {
                return Err(RpcFailure::invalid_params("path is required"));
            }
            let workspace_root = state.workspaces.current_root();
            let (_root, target) = workspace_target(&workspace_root, relative).await?;
            let metadata = fs::metadata(&target)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if metadata.len() > 1_048_576 {
                return Err(RpcFailure::application(
                    "workspace file exceeds 1 MiB RPC limit",
                ));
            }
            let bytes = fs::read(&target)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let binary = bytes.iter().take(8192).any(|byte| *byte == 0);
            let content = if binary {
                String::new()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            };
            serde_json::to_value(WorkspaceFileInfo {
                name: target
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_owned(),
                path: relative.to_owned(),
                size: metadata.len(),
                binary,
                truncated: false,
                content,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "tool.list" => {
            let definitions = serde_json::to_value(state.tool_registry.direct_definitions())
                .and_then(serde_json::from_value::<Vec<ToolInfo>>)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(definitions)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "model.read" => {
            let params: ModelReadParams = parse_params(params)?;
            let session_key = params.session_id.map(|session_id| session_id.to_string());
            let info = serde_json::from_value::<RuntimeModelInfo>(
                state.models.runtime_info_for(session_key.as_deref()).await,
            )
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(info).map_err(|error| RpcFailure::application(error.to_string()))
        }
        "model.catalog" => {
            require_mon_origin(runtime_origin, "model.catalog")?;
            let params: ModelCatalogParams = parse_params(params)?;
            if let Some(session_id) = params.session_id {
                ensure_session_model_mutable(state, session_id).await?;
            }
            let (assistant_id, vision_ai_entity_id) =
                session_model_identity(state, params.session_id).await?;
            let session_key = params.session_id.map(|session_id| session_id.to_string());
            let mut catalog = state
                .core_models
                .catalog_for(
                    &params.core_base_url,
                    &params.core_token,
                    &state.models,
                    session_key.as_deref(),
                    assistant_id.as_ref(),
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state
                .host_services
                .bind_core_credentials(
                    session_key.as_deref(),
                    &params.core_base_url,
                    &params.core_token,
                )
                .await
                .map_err(RpcFailure::application)?;
            if let Some(session_id) = params.session_id {
                catalog["actors"] = Value::Array(
                    configure_session_actor_models(
                        state,
                        session_id,
                        &params.core_base_url,
                        &params.core_token,
                    )
                    .await?,
                );
                state
                    .core_sync
                    .bind_session(session_id, &params.core_base_url, &params.core_token)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
                persist_session_model_binding(
                    state,
                    session_id,
                    assistant_id.as_ref(),
                    vision_ai_entity_id.as_ref(),
                    &catalog,
                )
                .await?;
            } else {
                state
                    .core_sync
                    .hydrate_credential(&params.core_base_url, &params.core_token)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            let catalog = serde_json::from_value::<RuntimeModelCatalogInfo>(catalog)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(catalog)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "model.select" => {
            require_mon_origin(runtime_origin, "model.select")?;
            let params: ModelSelectParams = parse_params(params)?;
            if let Some(session_id) = params.session_id {
                ensure_session_model_mutable(state, session_id).await?;
                state
                    .store
                    .append_event(
                        session_id,
                        None,
                        "session.model.change_requested",
                        json!({"aiEntityId": params.ai_entity_id.clone()}),
                    )
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            let (assistant_id, vision_ai_entity_id) =
                session_model_identity(state, params.session_id).await?;
            let session_key = params.session_id.map(|session_id| session_id.to_string());
            let mut catalog = state
                .core_models
                .select_for(
                    &params.core_base_url,
                    &params.core_token,
                    &params.ai_entity_id,
                    &state.models,
                    session_key.as_deref(),
                    assistant_id.as_ref(),
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state
                .host_services
                .bind_core_credentials(
                    session_key.as_deref(),
                    &params.core_base_url,
                    &params.core_token,
                )
                .await
                .map_err(RpcFailure::application)?;
            if let Some(session_id) = params.session_id {
                catalog["actors"] = Value::Array(
                    configure_session_actor_models(
                        state,
                        session_id,
                        &params.core_base_url,
                        &params.core_token,
                    )
                    .await?,
                );
                state
                    .core_sync
                    .bind_session(session_id, &params.core_base_url, &params.core_token)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
                persist_session_model_binding(
                    state,
                    session_id,
                    assistant_id.as_ref(),
                    vision_ai_entity_id.as_ref(),
                    &catalog,
                )
                .await?;
            } else {
                state
                    .core_sync
                    .hydrate_credential(&params.core_base_url, &params.core_token)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            let catalog = serde_json::from_value::<RuntimeModelCatalogInfo>(catalog)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(catalog)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "self_awake.list" => {
            let params: SelfAwakeListParams = parse_params(params)?;
            let page = params.page.max(1);
            let page_size = params.page_size.clamp(1, 100);
            let offset = page.saturating_sub(1).saturating_mul(page_size);
            let query = params
                .query
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let count = state
                .store
                .count_self_awake_runs(query)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let records = state
                .store
                .list_self_awake_runs(offset, page_size, query)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut results = Vec::with_capacity(records.len());
            for record in records {
                let diaries = state
                    .store
                    .list_self_awake_diaries_for_run(record.id)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?
                    .into_iter()
                    .map(|diary| SelfAwakeDiaryInfo {
                        id: diary.id.to_string(),
                        run_id: diary.run_id.to_string(),
                        session_id: diary.session_id,
                        assistant_id: diary.assistant_id,
                        character_id: diary.character_id,
                        title: diary.title,
                        content: diary.content,
                        mood: diary.mood,
                        metadata: diary.metadata,
                        created_at: diary.created_at,
                    })
                    .collect();
                results.push(SelfAwakeRunInfo {
                    id: record.id.to_string(),
                    job_id: record.job_id.to_string(),
                    session_id: record.session_id,
                    schema_version: record.schema_version,
                    event_id: record.event_id,
                    status: record.status,
                    request: record.request,
                    decision: record.decision,
                    author_snapshot: record.author_snapshot,
                    attempts: record.attempts,
                    last_error: record.last_error,
                    started_at: record.started_at,
                    completed_at: record.completed_at,
                    created_at: record.created_at,
                    updated_at: record.updated_at,
                    diaries,
                });
            }
            let total_pages = u32::try_from(count.div_ceil(u64::from(page_size)))
                .unwrap_or(u32::MAX)
                .max(1);
            serde_json::to_value(SelfAwakePage {
                count,
                page,
                page_size,
                total_pages,
                results,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}
