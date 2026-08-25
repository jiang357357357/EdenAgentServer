use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthResponse {
    status: &'static str,
    server_version: &'static str,
    agent_core_version: &'static str,
    protocol_version: u32,
    runtime_origin: RuntimeOrigin,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadinessCheck {
    ready: bool,
    required: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadinessResponse {
    status: &'static str,
    server_version: &'static str,
    protocol_version: u32,
    checked_at: i64,
    checks: BTreeMap<String, ReadinessCheck>,
}

pub(crate) fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/readyz", get(readiness))
        .route("/metrics", get(metrics))
        .route("/rpc", get(rpc_upgrade))
        .route("/voice/stt/realtime", get(realtime_stt_upgrade))
        .route("/blobs", post(blob_upload))
        .route("/blobs/{id}", get(blob_read))
        .layer(RequestBodyLimitLayer::new(state.blobs.max_bytes()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub(crate) async fn health(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(HealthResponse {
        status: "ok",
        server_version: env!("CARGO_PKG_VERSION"),
        agent_core_version: eden_agent_core::VERSION,
        protocol_version: PROTOCOL_VERSION,
        runtime_origin: state.runtime_origin,
    })
}

pub(crate) fn worker_readiness(
    heartbeat: &AtomicI64,
    now: i64,
    maximum_age_ms: i64,
) -> ReadinessCheck {
    let last_tick = heartbeat.load(Ordering::Relaxed);
    let age_ms = now.saturating_sub(last_tick).max(0);
    ReadinessCheck {
        ready: last_tick > 0 && age_ms <= maximum_age_ms,
        required: true,
        detail: if last_tick > 0 {
            format!("last tick {age_ms} ms ago")
        } else {
            "worker has not reported a heartbeat".to_owned()
        },
    }
}

pub(crate) async fn readiness(State(state): State<AppState>) -> Response {
    let now = chrono::Utc::now().timestamp_millis();
    let mut checks = BTreeMap::new();
    let database_started = Instant::now();
    let database = match state.store.database_probe().await {
        Ok(()) => ReadinessCheck {
            ready: true,
            required: true,
            detail: format!(
                "SQLite responded in {} ms",
                database_started.elapsed().as_millis()
            ),
        },
        Err(error) => ReadinessCheck {
            ready: false,
            required: true,
            detail: format!("SQLite probe failed: {error}"),
        },
    };
    checks.insert("database".to_owned(), database);
    checks.insert(
        "legacyMigrationAudit".to_owned(),
        match state.store.legacy_migration_audit().await {
            Ok(audit) => ReadinessCheck {
                ready: true,
                required: true,
                detail: format!(
                    "imported sessions={}, domain items={}; pending review: skill reinstalls={}, connector reconnects={}, quarantined work={}, permission reauthorization={}",
                    audit.imported_sessions,
                    audit.imported_domain_items,
                    audit.skills_requiring_reinstall,
                    audit.connectors_requiring_reconnect,
                    audit.quarantined_work_items,
                    audit.permission_reauthorization_required
                ),
            },
            Err(error) => ReadinessCheck {
                ready: false,
                required: true,
                detail: format!("legacy migration audit failed: {error}"),
            },
        },
    );
    checks.insert(
        "durableJobs".to_owned(),
        worker_readiness(
            state.diagnostics.durable_jobs_heartbeat.as_ref(),
            now,
            5_000,
        ),
    );
    checks.insert(
        "catalogWorker".to_owned(),
        worker_readiness(state.diagnostics.catalog_heartbeat.as_ref(), now, 5_000),
    );
    checks.insert(
        "coreSyncWorker".to_owned(),
        worker_readiness(state.diagnostics.core_sync_heartbeat.as_ref(), now, 10_000),
    );
    checks.insert(
        "connectorSupervisor".to_owned(),
        worker_readiness(state.diagnostics.connector_heartbeat.as_ref(), now, 10_000),
    );
    let models = state.models.availability().await;
    checks.insert(
        "model".to_owned(),
        ReadinessCheck {
            ready: models.is_ready(),
            // The Mon realm receives its model binding from Eden Core after a
            // Core session attaches.  Local must be independently usable at
            // startup and therefore still requires a configured model.
            required: state.runtime_origin == RuntimeOrigin::Local,
            detail: if models.is_ready() {
                format!(
                    "default={}, available sessions={}, unavailable sessions={}, available actors={}, unavailable actors={}",
                    models.default_available,
                    models.available_session_bindings,
                    models.unavailable_session_bindings,
                    models.available_actor_bindings,
                    models.unavailable_actor_bindings
                )
            } else {
                models
                    .default_error
                    .unwrap_or_else(|| "no usable model binding is configured".to_owned())
            },
        },
    );
    let workspace = state.workspaces.current_root();
    checks.insert(
        "workspace".to_owned(),
        ReadinessCheck {
            ready: workspace.is_dir(),
            required: true,
            detail: workspace.display().to_string(),
        },
    );
    checks.insert("toolRegistry".to_owned(), {
        let definitions = state.tool_registry.direct_definitions();
        ReadinessCheck {
            ready: !definitions.is_empty(),
            required: true,
            detail: format!("{} direct tools registered", definitions.len()),
        }
    });
    checks.insert(
        "processSandbox".to_owned(),
        ReadinessCheck {
            ready: state.diagnostics.process_sandbox_available,
            required: false,
            detail: if state.diagnostics.process_sandbox_available {
                "available; command tools enabled".to_owned()
            } else {
                "unavailable; command tools fail closed".to_owned()
            },
        },
    );
    let ready = checks.values().all(|check| !check.required || check.ready);
    let response = ReadinessResponse {
        status: if ready { "ready" } else { "not_ready" },
        server_version: env!("CARGO_PKG_VERSION"),
        protocol_version: PROTOCOL_VERSION,
        checked_at: now,
        checks,
    };
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(response),
    )
        .into_response()
}

pub(crate) async fn metrics(State(state): State<AppState>) -> Response {
    let started = Instant::now();
    let snapshot = match state.store.runtime_metrics_snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("unable to collect Eden Agent metrics: {error}\n"),
            )
                .into_response();
        }
    };
    let database_latency_seconds = started.elapsed().as_secs_f64();
    let now = chrono::Utc::now().timestamp_millis();
    let worker_age = |heartbeat: &AtomicI64| {
        let last_tick = heartbeat.load(Ordering::Relaxed);
        if last_tick > 0 {
            now.saturating_sub(last_tick).max(0) as f64 / 1_000.0
        } else {
            -1.0
        }
    };
    let models = state.models.availability().await;
    let migration = match state.store.legacy_migration_audit().await {
        Ok(audit) => audit,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("unable to collect Eden Agent migration metrics: {error}\n"),
            )
                .into_response();
        }
    };
    let mut body = String::new();
    macro_rules! metric {
        ($name:literal, $kind:literal, $help:literal, $value:expr) => {{
            body.push_str(concat!("# HELP ", $name, " ", $help, "\n"));
            body.push_str(concat!("# TYPE ", $name, " ", $kind, "\n"));
            body.push_str(&format!(concat!($name, " {}\n"), $value));
        }};
    }
    metric!(
        "eden_agent_active_sessions",
        "gauge",
        "Active durable sessions.",
        snapshot.active_sessions
    );
    metric!(
        "eden_agent_input_queue",
        "gauge",
        "Queued durable inputs.",
        snapshot.queued_inputs
    );
    metric!(
        "eden_agent_inputs_active",
        "gauge",
        "Claimed durable inputs.",
        snapshot.claimed_inputs
    );
    metric!(
        "eden_agent_subagents_active",
        "gauge",
        "Queued or running sub-agents.",
        snapshot.active_agents
    );
    metric!(
        "eden_agent_jobs_scheduled",
        "gauge",
        "Scheduled durable jobs.",
        snapshot.scheduled_jobs
    );
    metric!(
        "eden_agent_jobs_claimed",
        "gauge",
        "Claimed durable jobs.",
        snapshot.claimed_jobs
    );
    metric!(
        "eden_agent_connector_event_queue",
        "gauge",
        "Pending or claimed connector events.",
        snapshot.pending_connector_events
    );
    metric!(
        "eden_agent_core_sync_queue",
        "gauge",
        "Queued or claimed Core projections.",
        snapshot.pending_core_sync
    );
    metric!(
        "eden_agent_turns_started_total",
        "counter",
        "Turns started since runtime metrics were installed.",
        snapshot.turns_started
    );
    metric!(
        "eden_agent_turns_completed_total",
        "counter",
        "Turns completed since runtime metrics were installed.",
        snapshot.turns_completed
    );
    metric!(
        "eden_agent_turns_failed_total",
        "counter",
        "Turns failed since runtime metrics were installed.",
        snapshot.turns_failed
    );
    metric!(
        "eden_agent_provider_retries_total",
        "counter",
        "Provider retries since runtime metrics were installed.",
        snapshot.provider_retries
    );
    metric!(
        "eden_agent_tool_calls_started_total",
        "counter",
        "Tool calls started since runtime metrics were installed.",
        snapshot.tool_calls_started
    );
    metric!(
        "eden_agent_tool_calls_completed_total",
        "counter",
        "Tool calls completed since runtime metrics were installed.",
        snapshot.tool_calls_completed
    );
    metric!(
        "eden_agent_tool_calls_failed_total",
        "counter",
        "Tool calls failed since runtime metrics were installed.",
        snapshot.tool_calls_failed
    );
    metric!(
        "eden_agent_first_token_seconds_count",
        "counter",
        "First-token latency samples since runtime metrics were installed.",
        snapshot.first_token_samples
    );
    metric!(
        "eden_agent_first_token_seconds_sum",
        "counter",
        "Cumulative first-token latency in seconds.",
        snapshot.first_token_total_ms as f64 / 1_000.0
    );
    metric!(
        "eden_agent_turn_duration_seconds_count",
        "counter",
        "Turn duration samples since runtime metrics were installed.",
        snapshot.turn_duration_samples
    );
    metric!(
        "eden_agent_turn_duration_seconds_sum",
        "counter",
        "Cumulative turn duration in seconds.",
        snapshot.turn_duration_total_ms as f64 / 1_000.0
    );
    metric!(
        "eden_agent_tool_duration_seconds_count",
        "counter",
        "Tool duration samples since runtime metrics were installed.",
        snapshot.tool_duration_samples
    );
    metric!(
        "eden_agent_tool_duration_seconds_sum",
        "counter",
        "Cumulative tool duration in seconds.",
        snapshot.tool_duration_total_ms as f64 / 1_000.0
    );
    metric!(
        "eden_agent_database_scrape_latency_seconds",
        "gauge",
        "SQLite metrics query latency.",
        database_latency_seconds
    );
    metric!(
        "eden_agent_worker_durable_jobs_heartbeat_age_seconds",
        "gauge",
        "Durable job scheduler heartbeat age.",
        worker_age(state.diagnostics.durable_jobs_heartbeat.as_ref())
    );
    metric!(
        "eden_agent_worker_catalog_heartbeat_age_seconds",
        "gauge",
        "Catalog worker heartbeat age.",
        worker_age(state.diagnostics.catalog_heartbeat.as_ref())
    );
    metric!(
        "eden_agent_worker_core_sync_heartbeat_age_seconds",
        "gauge",
        "Core sync worker heartbeat age.",
        worker_age(state.diagnostics.core_sync_heartbeat.as_ref())
    );
    metric!(
        "eden_agent_worker_connectors_heartbeat_age_seconds",
        "gauge",
        "Connector supervisor heartbeat age.",
        worker_age(state.diagnostics.connector_heartbeat.as_ref())
    );
    metric!(
        "eden_agent_model_available",
        "gauge",
        "Whether at least one usable model binding exists.",
        if models.is_ready() { 1 } else { 0 }
    );
    metric!(
        "eden_agent_model_default_available",
        "gauge",
        "Whether the default model binding is usable.",
        if models.default_available { 1 } else { 0 }
    );
    metric!(
        "eden_agent_model_session_bindings_available",
        "gauge",
        "Usable session model bindings.",
        models.available_session_bindings
    );
    metric!(
        "eden_agent_model_session_bindings_unavailable",
        "gauge",
        "Unusable session model bindings.",
        models.unavailable_session_bindings
    );
    metric!(
        "eden_agent_model_actor_bindings_available",
        "gauge",
        "Usable actor model bindings.",
        models.available_actor_bindings
    );
    metric!(
        "eden_agent_model_actor_bindings_unavailable",
        "gauge",
        "Unusable actor model bindings.",
        models.unavailable_actor_bindings
    );
    metric!(
        "eden_agent_legacy_sessions_imported",
        "gauge",
        "Legacy MonCore sessions recorded as imported.",
        migration.imported_sessions
    );
    metric!(
        "eden_agent_legacy_domain_items_imported",
        "gauge",
        "Legacy MonCore domain items recorded as imported.",
        migration.imported_domain_items
    );
    metric!(
        "eden_agent_legacy_skill_reinstalls_pending",
        "gauge",
        "Legacy skills requiring explicit reinstall.",
        migration.skills_requiring_reinstall
    );
    metric!(
        "eden_agent_legacy_connector_reconnects_pending",
        "gauge",
        "Legacy connectors requiring explicit reconnect.",
        migration.connectors_requiring_reconnect
    );
    metric!(
        "eden_agent_legacy_work_items_quarantined",
        "gauge",
        "Legacy work items preserved without replay.",
        migration.quarantined_work_items
    );
    metric!(
        "eden_agent_legacy_permission_reauthorization_required",
        "gauge",
        "Whether a legacy elevated permission mode requires explicit reauthorization.",
        if migration.permission_reauthorization_required {
            1
        } else {
            0
        }
    );
    metric!(
        "eden_agent_process_uptime_seconds",
        "gauge",
        "Server process uptime.",
        now.saturating_sub(state.diagnostics.started_at).max(0) as f64 / 1_000.0
    );
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
        .into_response()
}

pub(crate) async fn blob_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !origin_allowed(&state, &headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    if !bearer_token_matches(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            "missing or invalid capability token",
        )
            .into_response();
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    match state.blobs.put(mime, &body).await {
        Ok(record) => (
            StatusCode::CREATED,
            Json(BlobInfo {
                id: record.id,
                sha256: record.sha256,
                mime: record.mime,
                byte_length: record.byte_length,
                created_at: record.created_at,
            }),
        )
            .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    }
}

pub(crate) async fn blob_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if !origin_allowed(&state, &headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    if !bearer_token_matches(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            "missing or invalid capability token",
        )
            .into_response();
    }
    let Ok(id) = id.parse() else {
        return (StatusCode::BAD_REQUEST, "invalid blob ID").into_response();
    };
    match state.blobs.read(id).await {
        Ok((record, bytes)) => {
            let mut response = bytes.into_response();
            if let Ok(value) = record.mime.parse() {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
        Err(error) => (StatusCode::NOT_FOUND, error.to_string()).into_response(),
    }
}

pub(crate) async fn rpc_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&state, &headers) {
        return (StatusCode::FORBIDDEN, "origin is not allowed").into_response();
    }
    if !token_matches(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            "missing or invalid capability token",
        )
            .into_response();
    }
    upgrade
        .max_message_size(2 * 1024 * 1024)
        .protocols([WEBSOCKET_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

pub(crate) fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|origin| state.allowed_origins.contains(origin))
}

pub(crate) fn token_matches(state: &AppState, headers: &HeaderMap) -> bool {
    if bearer_token_matches(state, headers) {
        return true;
    }
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .into_iter()
        .flat_map(|value| value.split(',').map(str::trim))
        .filter_map(|protocol| protocol.strip_prefix(TOKEN_PROTOCOL_PREFIX))
        .any(|token| token == state.capability_token.as_ref())
}

pub(crate) fn bearer_token_matches(state: &AppState, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    bearer.is_some_and(|token| token == state.capability_token.as_ref())
}

pub(crate) async fn handle_socket(socket: WebSocket, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let mut notifications = state.runtime.subscribe();
    let mut runtime_origin = None;

    loop {
        tokio::select! {
            frame = receiver.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        if process_client_text(
                            &mut sender,
                            &state,
                            &connection_id,
                            &mut runtime_origin,
                            &text,
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        warn!(%connection_id, %error, "websocket receive failed");
                        break;
                    }
                }
            }
            event = notifications.recv(), if runtime_origin.is_some() => {
                let notification = match event {
                    Ok(event) => {
                        let Some(origin) = runtime_origin else { continue };
                        let belongs_to_origin = state
                            .store
                            .get_session(event.session_id)
                            .await
                            .is_ok_and(|session| session_origin(&session) == origin);
                        if !belongs_to_origin {
                            continue;
                        }
                        RpcNotification::new("session.event", session_event(event))
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        RpcNotification::new(
                            "server.warning",
                            json!({
                                "code": "event_stream_lagged",
                                "skipped": skipped,
                                "recovery": "call event.list with the last observed sequence",
                            }),
                        )
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if send_json(&mut sender, &notification).await.is_err() {
                    break;
                }
            }
        }
    }
}

pub(crate) async fn process_client_text(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
    connection_id: &str,
    runtime_origin: &mut Option<RuntimeOrigin>,
    text: &str,
) -> Result<(), axum::Error> {
    let request = match serde_json::from_str::<RpcRequest>(text) {
        Ok(request) if request.jsonrpc == JSON_RPC_VERSION => request,
        Ok(request) => {
            return send_response(
                sender,
                RpcResponse::error(
                    request.id.unwrap_or(Value::Null),
                    -32600,
                    "invalid JSON-RPC version",
                ),
            )
            .await;
        }
        Err(error) => {
            return send_response(
                sender,
                RpcResponse::error(Value::Null, -32700, format!("parse error: {error}")),
            )
            .await;
        }
    };

    let Some(id) = request.id else {
        return Ok(());
    };
    let was_initialized = runtime_origin.is_some();
    let response = match request.method.as_str() {
        "initialize" if runtime_origin.is_none() => {
            match serde_json::from_value::<InitializeParams>(request.params) {
                Ok(params)
                    if params.protocol_version == PROTOCOL_VERSION
                        && params.runtime_origin == state.runtime_origin =>
                {
                    let origin = params.runtime_origin;
                    *runtime_origin = Some(origin);
                    RpcResponse::success(
                        id,
                        InitializeResult {
                            protocol_version: PROTOCOL_VERSION,
                            server_name: "eden-agent-server".to_owned(),
                            server_version: env!("CARGO_PKG_VERSION").to_owned(),
                            agent_core_version: eden_agent_core::VERSION.to_owned(),
                            capabilities: runtime_capabilities(origin),
                            runtime_origin: origin,
                        },
                    )
                }
                Ok(params) if params.protocol_version != PROTOCOL_VERSION => {
                    RpcResponse::error(id, -32001, "unsupported protocol version")
                }
                Ok(_) => RpcResponse::error(
                    id,
                    -32003,
                    "runtime_origin_mismatch: this server belongs to another runtime",
                ),
                Err(error) => {
                    RpcResponse::error(id, -32602, format!("invalid initialize params: {error}"))
                }
            }
        }
        "initialize" => RpcResponse::error(id, -32002, "connection is already initialized"),
        _ if runtime_origin.is_none() => {
            RpcResponse::error(id, -32000, "initialize must be the first request")
        }
        _ => match execute_method_for_origin(
            state,
            runtime_origin.unwrap_or(RuntimeOrigin::Mon),
            &request.method,
            request.params,
        )
        .await
        {
            Ok(result) => RpcResponse::success(id, result),
            Err(failure) => RpcResponse::error(id, failure.code, failure.message),
        },
    };
    send_response(sender, response).await?;
    if runtime_origin.is_some() && !was_initialized {
        send_json(
            sender,
            &RpcNotification::new(
                "server.ready",
                ReadyNotification {
                    connection_id: connection_id.to_owned(),
                },
            ),
        )
        .await?;
    }
    Ok(())
}

pub(crate) fn runtime_capabilities(origin: RuntimeOrigin) -> Vec<String> {
    let mut capabilities = vec![
        "session-events".to_owned(),
        "permissions".to_owned(),
        "durable-input".to_owned(),
        "durable-workspace-switch".to_owned(),
        "plugins-v1".to_owned(),
        "runtime-origin-v1".to_owned(),
        "voice-config-v1".to_owned(),
    ];
    match origin {
        RuntimeOrigin::Mon => {
            capabilities.extend([
                "core-sync".to_owned(),
                "core-model-catalog".to_owned(),
                "voice-tts".to_owned(),
                "voice-stt-realtime".to_owned(),
            ]);
        }
        RuntimeOrigin::Local => capabilities.extend([
            "local-model".to_owned(),
            "voice-tts".to_owned(),
            "voice-stt-realtime".to_owned(),
        ]),
    }
    capabilities
}

pub(crate) async fn send_response(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    response: RpcResponse,
) -> Result<(), axum::Error> {
    send_json(sender, &response).await
}

pub(crate) async fn send_json(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    value: &impl Serialize,
) -> Result<(), axum::Error> {
    sender
        .send(Message::Text(
            serde_json::to_string(value)
                .expect("RPC frame must serialize")
                .into(),
        ))
        .await
}
