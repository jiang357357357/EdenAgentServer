mod observability;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use mon_agent_api::{
    AgentListParams, AgentMessageParams, AgentReadParams, AgentThreadInfo, AgentThreadResultInfo,
    AgentThreadStatus, BlobInfo, ConnectorCatalogInfo, ConnectorCreateParams, ConnectorInfo,
    ConnectorUpdateParams, DirectorBeatInfo, DirectorExecutionInfo, DirectorListParams,
    DirectorRunInfo, DirectorRunStatus, DirectorSceneInfo, EventListParams, EventPage,
    InitializeParams, InitializeResult, JSON_RPC_VERSION, MediaListParams, MediaRequestInfo,
    MediaResolveParams, MemoCreateParams, MemoIdParams, MemoInfo, MemoListParams, MemoUpdateParams,
    MessageListParams, ModelCatalogParams, ModelReadParams, ModelSelectParams, OperationDecision,
    OperationInfo, OperationListParams, OperationResolveParams, PROTOCOL_VERSION,
    PermissionDecision, PermissionListParams, PermissionRequestInfo, PermissionResolveParams,
    ProtocolSchemaCatalog, QuestionListParams, QuestionRejectParams, QuestionRequestInfo,
    QuestionResolveParams, ReadyNotification, RpcNotification, RpcRequest, RpcResponse,
    RuntimeModelCatalogInfo, RuntimeModelInfo, SelfAwakeDiaryInfo, SelfAwakeListParams,
    SelfAwakePage, SelfAwakeRunInfo, SessionCompactParams, SessionCreateParams, SessionEnvironment,
    SessionEvent, SessionListParams, SessionParticipantsParams, SessionReadParams, SessionStatus,
    SessionSummary, SessionTitleParams, SkillEnableParams, SkillInfo, SkillInspectParams,
    SkillInstallParams, SkillListParams, SkillPreviewInfo, SkillPreviewInstallParams,
    SkillPreviewSource, SkillReadParams, TOKEN_PROTOCOL_PREFIX, ToolInfo, TurnAccepted,
    TurnQueueParams, TurnQueueResult, TurnStartParams, VoiceSpeechSegmentInfo,
    VoiceSpeechSegmentListParams, VoiceTtsSynthesizeParams, VoiceTtsSynthesizeResult,
    WEBSOCKET_PROTOCOL, WorkspaceDirectoryInfo, WorkspaceEntryInfo, WorkspaceEntryKind,
    WorkspaceFileInfo, WorkspaceInfo, WorkspacePathParams, WorkspaceSwitchParams,
};
use mon_agent_app::SessionRuntime;
use mon_agent_blob::BlobService;
use mon_agent_connectors::ConnectorService;
use mon_agent_core::{ModelAdapter, SessionId, ToolDefinition, ToolExecutionMode, ToolRegistry};
use mon_agent_core_sync::{CoreSyncError, CoreSyncService};
use mon_agent_host::HostServices;
use mon_agent_interaction::{MediaService, QuestionService};
use mon_agent_multiagent::{MultiAgentService, SubagentCatalog};
use mon_agent_provider::{CoreModelClient, DynamicModelProvider};
#[cfg(test)]
use mon_agent_provider::{UnavailableProvider, model_spec_from_env};
use mon_agent_sandbox::{
    ApprovalDecision, ApprovalService, PermissionMode as SandboxPermissionMode, PermissionPolicy,
    PolicyEffect,
};
use mon_agent_skills::{SkillCatalog, SkillDefinition};
use mon_agent_store::{EventRecord, SessionRecord, Store};
use mon_agent_tools::ProcessSandbox;
use mon_agent_workspace::WorkspaceService;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::SocketAddr,
    path::{Component, Path as StdPath, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Instant,
};
use tokio::fs;
use tokio_tungstenite::{connect_async, tungstenite::Message as UpstreamMessage};
use tokio_util::sync::CancellationToken;
use tower_http::{limit::RequestBodyLimitLayer, trace::TraceLayer};
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(
    name = "mon-agent-server",
    version,
    about = "MonAgent local Rust server"
)]
struct Args {
    #[arg(long, env = "MON_AGENT_BIND", default_value = "127.0.0.1:40092")]
    bind: SocketAddr,

    #[arg(long, env = "MON_AGENT_CAPABILITY_TOKEN")]
    capability_token: Option<String>,

    #[arg(
        long,
        env = "MON_AGENT_TOKEN_FILE",
        default_value = "Data/server-capability.token"
    )]
    token_file: PathBuf,

    #[arg(long, env = "MON_AGENT_DATABASE", default_value = "Data/mon-agent.db")]
    database: PathBuf,

    #[arg(long, env = "MON_AGENT_LOG_DIRECTORY", default_value = "Data/logs")]
    log_directory: PathBuf,

    #[arg(
        long,
        env = "MON_AGENT_LOG_MAX_BYTES",
        default_value_t = 10 * 1024 * 1024
    )]
    log_max_bytes: u64,

    #[arg(long, env = "MON_AGENT_LOG_MAX_FILES", default_value_t = 5)]
    log_max_files: usize,

    #[arg(
        long,
        env = "MON_AGENT_LEGACY_CORE_DATABASE",
        default_value = "../Core/Data/DB/SQLite/db.sqlite3"
    )]
    legacy_core_database: PathBuf,

    #[arg(long, env = "MON_AGENT_BLOB_ROOT", default_value = "Data/blobs")]
    blob_root: PathBuf,

    #[arg(long, env = "MON_AGENT_MAX_BLOB_BYTES", default_value_t = 32 * 1024 * 1024)]
    max_blob_bytes: usize,

    #[arg(long, env = "MON_AGENT_WORKSPACE_ROOT", default_value = ".")]
    workspace_root: PathBuf,

    #[arg(
        long,
        env = "MON_AGENT_SKILL_ROOTS",
        value_delimiter = ',',
        default_value = "Server/skills/builtin,.agents/skills"
    )]
    skill_roots: Vec<PathBuf>,

    #[arg(
        long,
        env = "MON_AGENT_SKILL_INSTALL_ROOT",
        default_value = "Data/skills"
    )]
    skill_install_root: PathBuf,

    #[arg(long, env = "MON_AGENT_SANDBOX_EXECUTABLE")]
    sandbox_executable: Option<PathBuf>,

    #[arg(long, env = "MON_CORE_BASE_URL")]
    core_base_url: Option<String>,

    #[arg(long, env = "MON_CORE_TOKEN")]
    core_token: Option<String>,

    #[arg(
        long,
        env = "MON_AGENT_ALLOWED_ORIGINS",
        value_delimiter = ',',
        default_value = "http://127.0.0.1:40091,http://localhost:40091,monagent://app"
    )]
    allowed_origins: Vec<String>,

    #[arg(long)]
    print_protocol_schema: bool,
}

#[derive(Clone)]
struct AppState {
    capability_token: Arc<str>,
    allowed_origins: Arc<HashSet<String>>,
    store: Store,
    runtime: SessionRuntime,
    approvals: ApprovalService,
    questions: QuestionService,
    media: MediaService,
    blobs: BlobService,
    skills: SkillCatalog,
    connectors: ConnectorService,
    multiagents: MultiAgentService,
    workspaces: WorkspaceService,
    tool_registry: ToolRegistry,
    host_services: HostServices,
    models: DynamicModelProvider,
    core_models: CoreModelClient,
    core_sync: CoreSyncService,
    diagnostics: Arc<RuntimeDiagnostics>,
}

struct RuntimeDiagnostics {
    started_at: i64,
    durable_jobs_heartbeat: Arc<AtomicI64>,
    catalog_heartbeat: Arc<AtomicI64>,
    core_sync_heartbeat: Arc<AtomicI64>,
    connector_heartbeat: Arc<AtomicI64>,
    process_sandbox_available: bool,
}

impl RuntimeDiagnostics {
    fn new(process_sandbox_available: bool) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            started_at: now,
            durable_jobs_heartbeat: Arc::new(AtomicI64::new(0)),
            catalog_heartbeat: Arc::new(AtomicI64::new(0)),
            core_sync_heartbeat: Arc::new(AtomicI64::new(0)),
            connector_heartbeat: Arc::new(AtomicI64::new(0)),
            process_sandbox_available,
        }
    }
}

#[derive(Clone)]
struct WorkspaceSkillRoots {
    configured: Arc<Vec<PathBuf>>,
    startup_root: Arc<PathBuf>,
}

impl WorkspaceSkillRoots {
    fn resolve(&self, workspace_root: &StdPath) -> Vec<PathBuf> {
        self.configured
            .iter()
            .map(|root| {
                if root.is_absolute() {
                    root.clone()
                } else if root.components().next().is_some_and(|component| {
                    matches!(component, Component::Normal(name) if name == ".agents" || name == ".monagent")
                }) {
                    workspace_root.join(root)
                } else {
                    self.startup_root.join(root)
                }
            })
            .collect()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    server_version: &'static str,
    agent_core_version: &'static str,
    protocol_version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessCheck {
    ready: bool,
    required: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessResponse {
    status: &'static str,
    server_version: &'static str,
    protocol_version: u32,
    checked_at: i64,
    checks: BTreeMap<String, ReadinessCheck>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.print_protocol_schema {
        println!(
            "{}",
            serde_json::to_string_pretty(&schemars::schema_for!(ProtocolSchemaCatalog))?
        );
        return Ok(());
    }

    observability::initialize(&args.log_directory, args.log_max_bytes, args.log_max_files)
        .map_err(|error| anyhow::anyhow!("initialize persistent logging: {error}"))?;

    let capability_token =
        resolve_capability_token(args.capability_token, &args.token_file).await?;
    if let Some(parent) = args.database.parent() {
        fs::create_dir_all(parent).await?;
    }
    let store = Store::open(&args.database).await?;
    let recovered_titles = store.recover_session_title_generations().await?;
    if recovered_titles > 0 {
        warn!(
            recovered_titles,
            "recovered interrupted session title generation"
        );
    }
    let core_sync = CoreSyncService::new(store.clone()).map_err(anyhow::Error::msg)?;
    if let (Some(core_base_url), Some(core_token)) =
        (args.core_base_url.as_deref(), args.core_token.as_deref())
    {
        core_sync
            .hydrate_credential(core_base_url, core_token)
            .await
            .map_err(anyhow::Error::msg)?;
    }
    if args.legacy_core_database.is_file() {
        match store
            .import_legacy_moncore_data(&args.legacy_core_database)
            .await
        {
            Ok(report)
                if report.sessions_imported > 0
                    || report.memories_imported > 0
                    || report.work_memories_imported > 0
                    || report.memos_imported > 0
                    || report.self_awake_runs_imported > 0
                    || report.director_runs_imported > 0
                    || report.connectors_imported > 0
                    || report.skills_recorded > 0
                    || report.permission_modes_imported > 0 =>
            {
                info!(
                    sessions_imported = report.sessions_imported,
                    messages_imported = report.messages_imported,
                    sessions_skipped = report.sessions_skipped,
                    memories_imported = report.memories_imported,
                    work_memories_imported = report.work_memories_imported,
                    memos_imported = report.memos_imported,
                    self_awake_runs_imported = report.self_awake_runs_imported,
                    self_awake_diaries_imported = report.self_awake_diaries_imported,
                    director_runs_imported = report.director_runs_imported,
                    connectors_imported = report.connectors_imported,
                    connector_events_imported = report.connector_events_imported,
                    skills_recorded = report.skills_recorded,
                    character_states_imported = report.character_states_imported,
                    permission_modes_imported = report.permission_modes_imported,
                    domain_items_skipped = report.domain_items_skipped,
                    source = %args.legacy_core_database.display(),
                    "imported legacy MonCore Agent data"
                )
            }
            Ok(_) => {}
            Err(error) => warn!(
                %error,
                source = %args.legacy_core_database.display(),
                "legacy MonCore session import failed; source data was not modified"
            ),
        }
    }
    let expired_interactions = store.expire_pending_interactions().await?;
    if expired_interactions > 0 {
        warn!(
            expired_interactions,
            "expired interactions orphaned by previous shutdown"
        );
    }
    let blobs = BlobService::new(&args.blob_root, store.clone(), args.max_blob_bytes).await?;
    let recovered_inputs = store.recover_claimed_inputs().await?;
    if recovered_inputs > 0 {
        warn!(
            recovered_inputs,
            "requeued inputs claimed before previous shutdown"
        );
    }
    let recovered_jobs = store.recover_claimed_jobs().await?;
    if recovered_jobs > 0 {
        warn!(
            recovered_jobs,
            "released durable job leases held by the previous server process"
        );
    }
    let recovered_handoffs = store
        .recover_legacy_credential_blocked_assistant_handoffs()
        .await?;
    if recovered_handoffs > 0 {
        warn!(
            recovered_handoffs,
            "requeued assistant handoffs blocked by the retired global Core credential path"
        );
    }
    let models = DynamicModelProvider::from_env();
    let model_spec = models.model_spec().await;
    if let Some(error) = models.error().await {
        warn!(%error, "environment model provider is not configured; Core configuration can attach it at runtime");
    }
    let model: Arc<dyn ModelAdapter> = Arc::new(models.clone());
    let core_models = CoreModelClient::new().map_err(anyhow::Error::msg)?;
    if let (Some(core_base_url), Some(core_token)) =
        (args.core_base_url.as_deref(), args.core_token.as_deref())
    {
        for binding in store.list_session_model_bindings().await? {
            if let Err(error) = core_models
                .configure_entity_for_session(
                    core_base_url,
                    core_token,
                    &Value::String(binding.ai_entity_id.clone()),
                    &binding.session_id.to_string(),
                    &models,
                )
                .await
            {
                warn!(
                    %error,
                    session_id = %binding.session_id,
                    ai_entity_id = %binding.ai_entity_id,
                    "failed to restore session model binding"
                );
            }
            if let Some(vision_ai_entity_id) = binding.vision_ai_entity_id.as_deref() {
                if let Err(error) = core_models
                    .configure_vision_entity_for_session(
                        core_base_url,
                        core_token,
                        &Value::String(vision_ai_entity_id.to_owned()),
                        &binding.session_id.to_string(),
                        &models,
                    )
                    .await
                {
                    warn!(
                        %error,
                        session_id = %binding.session_id,
                        ai_entity_id = %vision_ai_entity_id,
                        "failed to restore session vision model binding"
                    );
                }
            }
        }
        for binding in store.list_session_actor_model_bindings(None).await? {
            if let Err(error) = core_models
                .configure_entity_for_actor_session(
                    core_base_url,
                    core_token,
                    &Value::String(binding.ai_entity_id.clone()),
                    &binding.session_id.to_string(),
                    &binding.assistant_id,
                    &models,
                )
                .await
            {
                warn!(%error, session_id=%binding.session_id, assistant_id=%binding.assistant_id, "failed to restore actor model binding");
            }
            if let Some(vision_id) = binding.vision_ai_entity_id.as_deref() {
                if let Err(error) = core_models
                    .configure_vision_entity_for_actor_session(
                        core_base_url,
                        core_token,
                        &Value::String(vision_id.to_owned()),
                        &binding.session_id.to_string(),
                        &binding.assistant_id,
                        &models,
                    )
                    .await
                {
                    warn!(%error, session_id=%binding.session_id, assistant_id=%binding.assistant_id, "failed to restore actor vision model binding");
                }
            }
        }
    }
    let approvals = ApprovalService::new(store.clone(), PermissionPolicy::new(PolicyEffect::Ask));
    if let Some(mode) = store
        .get_config("permission.mode")
        .await?
        .and_then(|value| value.as_str().and_then(SandboxPermissionMode::parse))
    {
        approvals.hydrate_mode(mode);
    }
    let questions = QuestionService::new(store.clone());
    let media = MediaService::new(store.clone(), blobs.clone());
    let process_sandbox = resolve_process_sandbox(args.sandbox_executable.as_deref());
    let process_sandbox_available = process_sandbox.is_available();
    if !process_sandbox_available {
        warn!("no process sandbox is available; command tools remain disabled");
    }
    let workspaces =
        WorkspaceService::initialize(store.clone(), &args.workspace_root, process_sandbox.clone())
            .await
            .map_err(anyhow::Error::msg)?;
    let workspace_root = workspaces.current_root();
    let workspace_skill_roots = WorkspaceSkillRoots {
        configured: Arc::new(args.skill_roots.clone()),
        startup_root: Arc::new(std::env::current_dir()?),
    };
    let skills = SkillCatalog::discover(
        &workspace_skill_roots.resolve(&workspace_root),
        args.skill_install_root.clone(),
    )?;
    for diagnostic in skills.diagnostics() {
        warn!(
            code = %diagnostic.code,
            path = %diagnostic.path.display(),
            message = %diagnostic.message,
            "skill diagnostic"
        );
    }
    let mut tools = native_tool_registry(&workspaces, process_sandbox.is_available());
    for tool in workspaces.tools() {
        tools.register(tool);
    }
    tools.register(Arc::new(questions.clone()));
    for tool in media.tools() {
        tools.register(tool);
    }
    for tool in skills.tools() {
        tools.register(tool);
    }
    let host_services = HostServices::new(
        store.clone(),
        args.core_base_url.as_deref(),
        args.core_token.as_deref(),
    )
    .map_err(anyhow::Error::msg)?
    .with_blob_service(blobs.clone());
    for tool in host_services.tools() {
        tools.register(tool);
    }
    let connectors = ConnectorService::new(store.clone()).map_err(anyhow::Error::msg)?;
    for tool in connectors.tools() {
        tools.register(tool);
    }
    if let Some(source) = skills.code_tool_source(process_sandbox.clone()) {
        tools.register_dynamic_source(source);
    }
    let system_prompt = skill_system_prompt(&skills);
    let subagent_catalog =
        SubagentCatalog::discover(&workspace_root, None).map_err(anyhow::Error::msg)?;
    let subagent_skills = skills.clone();
    let multiagents = MultiAgentService::new_with_catalog_and_skills(
        store.clone(),
        model_spec.clone(),
        Arc::clone(&model),
        tools.clone(),
        Arc::new(approvals.clone()),
        &system_prompt,
        4,
        workspace_root.clone(),
        subagent_catalog,
        Arc::new(move |names| {
            subagent_skills
                .prompt_snapshot_for_profile(names, "subagent")
                .map_err(|error| error.to_string())
        }),
    );
    for tool in multiagents.tools() {
        tools.register(tool);
    }
    let registered_tool_definitions = tools.direct_definitions();
    mon_agent_core::validate_tool_definitions(&registered_tool_definitions)
        .map_err(|error| anyhow::anyhow!("registered tool contract is invalid: {error}"))?;
    skills.set_known_tools(
        registered_tool_definitions
            .into_iter()
            .filter(|definition| definition.source != "skill")
            .map(|definition| definition.name),
    )?;
    let system_prompt = skill_system_prompt(&skills);
    multiagents.set_system_prompt(&system_prompt);
    let recovered_agents = multiagents.resume().await?;
    if recovered_agents > 0 {
        warn!(recovered_agents, "resumed durable sub-agent threads");
    }
    let tool_registry = tools.clone();
    let runtime = SessionRuntime::new_with_services(
        store.clone(),
        model_spec,
        model,
        tools,
        Arc::new(approvals.clone()),
        Some(blobs.clone()),
        system_prompt,
    );
    runtime.resume().await?;
    let diagnostics = Arc::new(RuntimeDiagnostics::new(process_sandbox_available));
    let catalog_worker = spawn_catalog_worker(
        skills.clone(),
        runtime.clone(),
        multiagents.clone(),
        workspaces.clone(),
        workspace_skill_roots,
        Arc::clone(&diagnostics.catalog_heartbeat),
    );
    let jobs = tokio::spawn(run_durable_jobs(
        store.clone(),
        runtime.clone(),
        core_models.clone(),
        models.clone(),
        core_sync.clone(),
        Arc::clone(&diagnostics.durable_jobs_heartbeat),
    ));
    let core_sync_worker = tokio::spawn(core_sync.clone().run_with_heartbeat(
        CancellationToken::new(),
        Arc::clone(&diagnostics.core_sync_heartbeat),
    ));
    let connector_supervisor =
        connectors.start_with_heartbeat(Arc::clone(&diagnostics.connector_heartbeat));
    let state = AppState {
        capability_token: Arc::from(capability_token),
        allowed_origins: Arc::new(args.allowed_origins.into_iter().collect()),
        store,
        runtime: runtime.clone(),
        approvals,
        questions,
        media,
        blobs,
        skills,
        connectors: connectors.clone(),
        multiagents,
        workspaces,
        tool_registry,
        host_services,
        models,
        core_models,
        core_sync,
        diagnostics,
    };
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind {}", args.bind))?;
    info!(
        address = %args.bind,
        token_file = %args.token_file.display(),
        database = %args.database.display(),
        workspace = %workspace_root.display(),
        "MonAgent Rust server listening"
    );
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server failed");
    runtime.shutdown().await;
    jobs.abort();
    connector_supervisor.abort();
    core_sync_worker.abort();
    catalog_worker.abort();
    result
}

fn skill_system_prompt(skills: &SkillCatalog) -> String {
    format!(
        "You are MonAgent, a local assistant. Use tools carefully and explain consequential actions.{}",
        skills.inventory_prompt()
    )
}

fn apply_skill_system_prompt(state: &AppState) {
    let prompt = skill_system_prompt(&state.skills);
    state.runtime.set_system_prompt(&prompt);
    state.multiagents.set_system_prompt(prompt);
}

fn skill_info(catalog: &SkillCatalog, skill: SkillDefinition, include_content: bool) -> SkillInfo {
    let missing_tools = catalog.missing_tools(&skill);
    SkillInfo {
        enabled: catalog.is_enabled(&skill.name),
        available: missing_tools.is_empty(),
        missing_tools,
        name: skill.name,
        display_name: skill.display_name,
        description: skill.description,
        version: skill.version,
        model_invocable: !skill.disable_model_invocation,
        scope: skill.scope,
        source_type: skill.source_type,
        tools: skill.tools,
        profiles: skill.profiles,
        permissions: skill.permissions,
        default_prompt: skill.default_prompt,
        content_hash: skill.content_hash,
        total_bytes: skill.total_bytes,
        files: skill.files,
        manifest: skill.manifest,
        content: include_content.then_some(skill.content),
    }
}

fn spawn_catalog_worker(
    skills: SkillCatalog,
    runtime: SessionRuntime,
    multiagents: MultiAgentService,
    workspaces: WorkspaceService,
    workspace_skill_roots: WorkspaceSkillRoots,
    heartbeat: Arc<AtomicI64>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            heartbeat.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
            let pending = match workspaces.state().await {
                Ok(state) => state.pending_path,
                Err(error) => {
                    warn!(%error, "failed to read durable workspace state");
                    None
                }
            };
            if let Some(pending) = pending {
                match workspaces.runtime_is_idle().await {
                    Ok(true) => {
                        let target = PathBuf::from(&pending);
                        let new_catalog = SubagentCatalog::discover(&target, None);
                        let new_roots = workspace_skill_roots.resolve(&target);
                        let validation = new_catalog.and_then(|catalog| {
                            skills
                                .replace_roots(new_roots)
                                .map_err(|error| error.to_string())?;
                            Ok(catalog)
                        });
                        match validation {
                            Ok(new_catalog) => {
                                let previous_root = workspaces.current_root();
                                let previous_roots = workspace_skill_roots.resolve(&previous_root);
                                let previous_catalog =
                                    SubagentCatalog::discover(&previous_root, None);
                                multiagents.reconfigure_workspace(target.clone(), new_catalog);
                                let prompt = skill_system_prompt(&skills);
                                runtime.set_system_prompt(&prompt);
                                multiagents.set_system_prompt(prompt);
                                match workspaces.commit_pending(&target).await {
                                    Ok(_) => {
                                        info!(workspace = %target.display(), "workspace switch applied")
                                    }
                                    Err(error) => {
                                        let _ = skills.replace_roots(previous_roots);
                                        if let Ok(previous_catalog) = previous_catalog {
                                            multiagents.reconfigure_workspace(
                                                previous_root,
                                                previous_catalog,
                                            );
                                        }
                                        let prompt = skill_system_prompt(&skills);
                                        runtime.set_system_prompt(&prompt);
                                        multiagents.set_system_prompt(prompt);
                                        warn!(%error, workspace = %target.display(), "workspace switch commit failed and runtime configuration was rolled back");
                                    }
                                }
                            }
                            Err(error) => {
                                if let Err(store_error) =
                                    workspaces.fail_pending(&target, &error).await
                                {
                                    warn!(%store_error, %error, workspace = %target.display(), "failed to reject invalid workspace switch");
                                } else {
                                    warn!(%error, workspace = %target.display(), "workspace switch rejected during validation");
                                }
                            }
                        }
                        continue;
                    }
                    Ok(false) => {}
                    Err(error) => warn!(%error, "failed to check workspace runtime idleness"),
                }
            }
            let catalog = skills.clone();
            match tokio::task::spawn_blocking(move || catalog.refresh()).await {
                Ok(Ok(true)) => {
                    let prompt = skill_system_prompt(&skills);
                    runtime.set_system_prompt(&prompt);
                    multiagents.set_system_prompt(prompt);
                    info!("skill catalog refreshed");
                }
                Ok(Ok(false)) => {}
                Ok(Err(error)) => warn!(%error, "skill catalog refresh rejected"),
                Err(error) => warn!(%error, "skill catalog refresh task failed"),
            }
        }
    })
}

async fn run_durable_jobs(
    store: Store,
    runtime: SessionRuntime,
    core_models: CoreModelClient,
    models: DynamicModelProvider,
    core_sync: CoreSyncService,
    heartbeat: Arc<AtomicI64>,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
    loop {
        interval.tick().await;
        heartbeat.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
        let jobs = match store.claim_due_jobs(32, 300_000).await {
            Ok(jobs) => jobs,
            Err(error) => {
                warn!(%error, "failed to claim durable jobs");
                continue;
            }
        };
        for job in jobs {
            let result = async {
                let session_id = job.session_id.context("job has no target session")?;
                if job.kind == "assistant.handoff" {
                    return dispatch_assistant_handoff(
                        &store,
                        &runtime,
                        &core_models,
                        &models,
                        &core_sync,
                        job.id,
                        session_id,
                        &job.payload,
                    )
                    .await;
                }
                let prompt = match job.kind.as_str() {
                    "memo.reminder" => {
                        let memo_id = job.payload.get("memoId").and_then(Value::as_i64).context("memo job has no memoId")?;
                        let memo = store.get_memo(memo_id).await?;
                        format!("A durable reminder is due now. Notify the user naturally.\n\nTitle: {}\nDetails: {}", memo.title, memo.content)
                    }
                    "self_awake" => job.payload.get("prompt").and_then(Value::as_str).unwrap_or("Run the scheduled self-awake check.").to_owned(),
                    other => anyhow::bail!("unknown durable job kind: {other}"),
                };
                runtime
                    .submit_job_turn(
                        session_id,
                        prompt,
                        job.id,
                        &job.kind,
                        job.payload.get("memoId").and_then(Value::as_i64),
                    )
                    .await?;
                anyhow::Ok(())
            }.await;
            let maximum_attempts = if job.kind == "assistant.handoff" {
                20
            } else {
                5
            };
            match result {
                Ok(()) => info!(
                    job_id = %job.id,
                    job_kind = %job.kind,
                    session_id = ?job.session_id,
                    "durable job dispatched"
                ),
                Err(error) => {
                    let already_committed = store
                        .get_job(job.id)
                        .await
                        .is_ok_and(|persisted| persisted.state == "completed");
                    if already_committed {
                        warn!(
                            %error,
                            job_id = %job.id,
                            job_kind = %job.kind,
                            session_id = ?job.session_id,
                            "durable job committed, but its post-commit wake notification failed"
                        );
                        continue;
                    }
                    if job.kind == "assistant.handoff"
                        && assistant_handoff_waits_for_core_credential(&error)
                    {
                        let retry_at = chrono::Utc::now().timestamp_millis() + 5_000;
                        let _ = store
                            .fail_job(job.id, &error.to_string(), Some(retry_at))
                            .await;
                        if job.attempts == 0 || job.attempts % 12 == 0 {
                            warn!(
                                job_id = %job.id,
                                session_id = ?job.session_id,
                                retry_at,
                                attempts = job.attempts,
                                "assistant handoff is waiting for the session Core credential"
                            );
                        }
                        continue;
                    }
                    if job.attempts < maximum_attempts {
                        let delay = if job.kind == "assistant.handoff" {
                            1_000_i64
                                .saturating_mul(1_i64 << job.attempts.min(5))
                                .min(30_000)
                        } else {
                            5_000_i64.saturating_mul(1_i64 << job.attempts.min(6))
                        };
                        let retry_at = chrono::Utc::now().timestamp_millis() + delay;
                        let _ = store
                            .fail_job(job.id, &error.to_string(), Some(retry_at))
                            .await;
                        warn!(
                            %error,
                            job_id = %job.id,
                            job_kind = %job.kind,
                            session_id = ?job.session_id,
                            retry_at,
                            attempts = job.attempts,
                            "durable job dispatch failed; retry scheduled"
                        );
                    } else {
                        let _ = store.fail_job(job.id, &error.to_string(), None).await;
                        if let Some(session_id) = job.session_id {
                            if job.kind == "assistant.handoff" {
                                let _ = store
                                    .append_event(
                                        session_id,
                                        None,
                                        "session.assistant_handoff.failed",
                                        json!({
                                            "jobId":job.id,
                                            "assistantId":job.payload.get("assistantId"),
                                            "participant":job.payload.get("participant"),
                                            "sourceParticipant":job.payload.get("sourceParticipant"),
                                            "error":error.to_string(),
                                            "attempts":job.attempts,
                                            "sourceIdentityPreserved":true,
                                        }),
                                    )
                                    .await;
                            }
                            let _ = runtime.wake(session_id).await;
                        }
                        warn!(
                            %error,
                            job_id = %job.id,
                            job_kind = %job.kind,
                            session_id = ?job.session_id,
                            attempts = job.attempts,
                            "durable job dispatch failed permanently"
                        );
                    }
                }
            }
        }
    }
}

fn assistant_handoff_waits_for_core_credential(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<CoreSyncError>(),
            Some(CoreSyncError::CredentialUnavailable(_))
        )
    })
}

async fn dispatch_assistant_handoff(
    store: &Store,
    runtime: &SessionRuntime,
    core_models: &CoreModelClient,
    models: &DynamicModelProvider,
    core_sync: &CoreSyncService,
    job_id: uuid::Uuid,
    session_id: SessionId,
    payload: &Value,
) -> anyhow::Result<()> {
    let participant = payload
        .get("participant")
        .filter(|value| value.is_object())
        .cloned()
        .context("assistant handoff has no participant")?;
    let assistant_id = payload
        .get("assistantId")
        .filter(|value| !value.is_null())
        .context("assistant handoff has no assistantId")?;
    let core_credential = core_sync.session_credential(session_id).await?;
    let core_base_url = core_credential.base_url();
    let core_token = core_credential.token();

    store.ensure_assistant_handoff_ready(session_id).await?;
    let session_key = session_id.to_string();
    let model_snapshot = models.snapshot_session(&session_key).await;
    let prepared: anyhow::Result<(Value, Value, String, String, Option<String>)> = async {
        let actor = core_models
            .configure_assistant_for_session(
                core_base_url,
                core_token,
                assistant_id,
                &session_key,
                models,
            )
            .await?;
        let main_id = actor
            .get("main")
            .and_then(|value| value.get("aiEntityId"))
            .filter(|value| !value.is_null())
            .context("assistant handoff resolved no main model")?;
        let vision_id = actor
            .get("vision")
            .and_then(|value| value.get("aiEntityId"))
            .filter(|value| !value.is_null());
        let session_model = core_models
            .configure_entity_for_session(core_base_url, core_token, main_id, &session_key, models)
            .await?;
        if let Some(vision_id) = vision_id {
            core_models
                .configure_vision_entity_for_session(
                    core_base_url,
                    core_token,
                    vision_id,
                    &session_key,
                    models,
                )
                .await?;
        } else {
            models.clear_vision_for(&session_key).await;
            models
                .clear_vision_for_actor(&session_key, &json_id(Some(assistant_id)))
                .await;
        }
        let assistant_key = json_id(Some(assistant_id));
        let main_key = json_id(Some(main_id));
        let vision_key = vision_id.map(|value| json_id(Some(value)));
        Ok((actor, session_model, assistant_key, main_key, vision_key))
    }
    .await;
    let (actor, session_model, assistant_key, main_key, vision_key) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            models.restore_session(model_snapshot).await;
            return Err(error);
        }
    };
    let committed = store
        .commit_assistant_handoff(
            job_id,
            session_id,
            participant,
            &assistant_key,
            &main_key,
            vision_key.as_deref(),
            session_model,
            actor.get("main").cloned().unwrap_or_else(|| json!({})),
            "<assistant_handoff>这是系统内部交接，不是用户的新消息。你已接管当前会话；请基于历史中最近一条用户消息直接回应，不要替原助手告别，也不要声称用户重复了请求。</assistant_handoff>",
        )
        .await;
    if let Err(error) = committed {
        models.restore_session(model_snapshot).await;
        return Err(error.into());
    }
    models
        .retain_session_actor(&session_key, &assistant_key)
        .await;
    if runtime.wake(session_id).await.is_err() {
        runtime.forget_session(session_id).await;
        runtime
            .wake(session_id)
            .await
            .context("assistant handoff committed but target session actor could not be woken")?;
    }
    Ok(())
}

fn build_router(state: AppState) -> Router {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct RealtimeSttQuery {
    session_id: SessionId,
}

async fn realtime_stt_upgrade(
    State(state): State<AppState>,
    Query(query): Query<RealtimeSttQuery>,
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
    if let Err(error) = state.store.get_session(query.session_id).await {
        return (StatusCode::NOT_FOUND, error.to_string()).into_response();
    }
    let upstream_url = match state
        .host_services
        .realtime_stt_url(&query.session_id.to_string())
        .await
    {
        Ok(url) => url,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    };
    upgrade
        .max_message_size(2 * 1024 * 1024)
        .protocols([WEBSOCKET_PROTOCOL])
        .on_upgrade(move |socket| proxy_realtime_stt(socket, upstream_url))
        .into_response()
}

async fn proxy_realtime_stt(socket: WebSocket, upstream_url: String) {
    let (upstream, _) = match connect_async(&upstream_url).await {
        Ok(connected) => connected,
        Err(error) => {
            let (mut sender, _) = socket.split();
            let payload = json!({
                "type": "error",
                "message": format!("Mon Core realtime STT connection failed: {error}"),
            });
            let _ = sender.send(Message::Text(payload.to_string().into())).await;
            return;
        }
    };
    let (mut client_sender, mut client_receiver) = socket.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream.split();

    loop {
        tokio::select! {
            client = client_receiver.next() => {
                let Some(Ok(message)) = client else { break };
                let message = match message {
                    Message::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                    Message::Binary(bytes) => UpstreamMessage::Binary(bytes.to_vec().into()),
                    Message::Ping(bytes) => UpstreamMessage::Ping(bytes.to_vec().into()),
                    Message::Pong(bytes) => UpstreamMessage::Pong(bytes.to_vec().into()),
                    Message::Close(_) => break,
                };
                if upstream_sender.send(message).await.is_err() { break; }
            }
            upstream = upstream_receiver.next() => {
                let Some(Ok(message)) = upstream else { break };
                let message = match message {
                    UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                    UpstreamMessage::Binary(bytes) => Message::Binary(bytes.to_vec().into()),
                    UpstreamMessage::Ping(bytes) => Message::Ping(bytes.to_vec().into()),
                    UpstreamMessage::Pong(bytes) => Message::Pong(bytes.to_vec().into()),
                    UpstreamMessage::Close(_) => break,
                    UpstreamMessage::Frame(_) => continue,
                };
                if client_sender.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = upstream_sender.close().await;
    let _ = client_sender.close().await;
}

async fn cache_core_audio(
    state: &AppState,
    session_id: &str,
    source: &str,
) -> Result<mon_agent_core::BlobId, RpcFailure> {
    let (mime, bytes) = state
        .host_services
        .fetch_core_audio(session_id, source)
        .await
        .map_err(RpcFailure::application)?;
    state
        .blobs
        .put(mime, &bytes)
        .await
        .map(|record| record.id)
        .map_err(|error| RpcFailure::application(error.to_string()))
}

async fn health() -> impl IntoResponse {
    axum::Json(HealthResponse {
        status: "ok",
        server_version: env!("CARGO_PKG_VERSION"),
        agent_core_version: mon_agent_core::VERSION,
        protocol_version: PROTOCOL_VERSION,
    })
}

fn worker_readiness(heartbeat: &AtomicI64, now: i64, maximum_age_ms: i64) -> ReadinessCheck {
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

async fn readiness(State(state): State<AppState>) -> Response {
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
            required: true,
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

async fn metrics(State(state): State<AppState>) -> Response {
    let started = Instant::now();
    let snapshot = match state.store.runtime_metrics_snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("unable to collect MonAgent metrics: {error}\n"),
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
                format!("unable to collect MonAgent migration metrics: {error}\n"),
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
        "mon_agent_active_sessions",
        "gauge",
        "Active durable sessions.",
        snapshot.active_sessions
    );
    metric!(
        "mon_agent_input_queue",
        "gauge",
        "Queued durable inputs.",
        snapshot.queued_inputs
    );
    metric!(
        "mon_agent_inputs_active",
        "gauge",
        "Claimed durable inputs.",
        snapshot.claimed_inputs
    );
    metric!(
        "mon_agent_subagents_active",
        "gauge",
        "Queued or running sub-agents.",
        snapshot.active_agents
    );
    metric!(
        "mon_agent_jobs_scheduled",
        "gauge",
        "Scheduled durable jobs.",
        snapshot.scheduled_jobs
    );
    metric!(
        "mon_agent_jobs_claimed",
        "gauge",
        "Claimed durable jobs.",
        snapshot.claimed_jobs
    );
    metric!(
        "mon_agent_connector_event_queue",
        "gauge",
        "Pending or claimed connector events.",
        snapshot.pending_connector_events
    );
    metric!(
        "mon_agent_core_sync_queue",
        "gauge",
        "Queued or claimed Core projections.",
        snapshot.pending_core_sync
    );
    metric!(
        "mon_agent_turns_started_total",
        "counter",
        "Turns started since runtime metrics were installed.",
        snapshot.turns_started
    );
    metric!(
        "mon_agent_turns_completed_total",
        "counter",
        "Turns completed since runtime metrics were installed.",
        snapshot.turns_completed
    );
    metric!(
        "mon_agent_turns_failed_total",
        "counter",
        "Turns failed since runtime metrics were installed.",
        snapshot.turns_failed
    );
    metric!(
        "mon_agent_provider_retries_total",
        "counter",
        "Provider retries since runtime metrics were installed.",
        snapshot.provider_retries
    );
    metric!(
        "mon_agent_tool_calls_started_total",
        "counter",
        "Tool calls started since runtime metrics were installed.",
        snapshot.tool_calls_started
    );
    metric!(
        "mon_agent_tool_calls_completed_total",
        "counter",
        "Tool calls completed since runtime metrics were installed.",
        snapshot.tool_calls_completed
    );
    metric!(
        "mon_agent_tool_calls_failed_total",
        "counter",
        "Tool calls failed since runtime metrics were installed.",
        snapshot.tool_calls_failed
    );
    metric!(
        "mon_agent_first_token_seconds_count",
        "counter",
        "First-token latency samples since runtime metrics were installed.",
        snapshot.first_token_samples
    );
    metric!(
        "mon_agent_first_token_seconds_sum",
        "counter",
        "Cumulative first-token latency in seconds.",
        snapshot.first_token_total_ms as f64 / 1_000.0
    );
    metric!(
        "mon_agent_turn_duration_seconds_count",
        "counter",
        "Turn duration samples since runtime metrics were installed.",
        snapshot.turn_duration_samples
    );
    metric!(
        "mon_agent_turn_duration_seconds_sum",
        "counter",
        "Cumulative turn duration in seconds.",
        snapshot.turn_duration_total_ms as f64 / 1_000.0
    );
    metric!(
        "mon_agent_tool_duration_seconds_count",
        "counter",
        "Tool duration samples since runtime metrics were installed.",
        snapshot.tool_duration_samples
    );
    metric!(
        "mon_agent_tool_duration_seconds_sum",
        "counter",
        "Cumulative tool duration in seconds.",
        snapshot.tool_duration_total_ms as f64 / 1_000.0
    );
    metric!(
        "mon_agent_database_scrape_latency_seconds",
        "gauge",
        "SQLite metrics query latency.",
        database_latency_seconds
    );
    metric!(
        "mon_agent_worker_durable_jobs_heartbeat_age_seconds",
        "gauge",
        "Durable job scheduler heartbeat age.",
        worker_age(state.diagnostics.durable_jobs_heartbeat.as_ref())
    );
    metric!(
        "mon_agent_worker_catalog_heartbeat_age_seconds",
        "gauge",
        "Catalog worker heartbeat age.",
        worker_age(state.diagnostics.catalog_heartbeat.as_ref())
    );
    metric!(
        "mon_agent_worker_core_sync_heartbeat_age_seconds",
        "gauge",
        "Core sync worker heartbeat age.",
        worker_age(state.diagnostics.core_sync_heartbeat.as_ref())
    );
    metric!(
        "mon_agent_worker_connectors_heartbeat_age_seconds",
        "gauge",
        "Connector supervisor heartbeat age.",
        worker_age(state.diagnostics.connector_heartbeat.as_ref())
    );
    metric!(
        "mon_agent_model_available",
        "gauge",
        "Whether at least one usable model binding exists.",
        if models.is_ready() { 1 } else { 0 }
    );
    metric!(
        "mon_agent_model_default_available",
        "gauge",
        "Whether the default model binding is usable.",
        if models.default_available { 1 } else { 0 }
    );
    metric!(
        "mon_agent_model_session_bindings_available",
        "gauge",
        "Usable session model bindings.",
        models.available_session_bindings
    );
    metric!(
        "mon_agent_model_session_bindings_unavailable",
        "gauge",
        "Unusable session model bindings.",
        models.unavailable_session_bindings
    );
    metric!(
        "mon_agent_model_actor_bindings_available",
        "gauge",
        "Usable actor model bindings.",
        models.available_actor_bindings
    );
    metric!(
        "mon_agent_model_actor_bindings_unavailable",
        "gauge",
        "Unusable actor model bindings.",
        models.unavailable_actor_bindings
    );
    metric!(
        "mon_agent_legacy_sessions_imported",
        "gauge",
        "Legacy MonCore sessions recorded as imported.",
        migration.imported_sessions
    );
    metric!(
        "mon_agent_legacy_domain_items_imported",
        "gauge",
        "Legacy MonCore domain items recorded as imported.",
        migration.imported_domain_items
    );
    metric!(
        "mon_agent_legacy_skill_reinstalls_pending",
        "gauge",
        "Legacy skills requiring explicit reinstall.",
        migration.skills_requiring_reinstall
    );
    metric!(
        "mon_agent_legacy_connector_reconnects_pending",
        "gauge",
        "Legacy connectors requiring explicit reconnect.",
        migration.connectors_requiring_reconnect
    );
    metric!(
        "mon_agent_legacy_work_items_quarantined",
        "gauge",
        "Legacy work items preserved without replay.",
        migration.quarantined_work_items
    );
    metric!(
        "mon_agent_legacy_permission_reauthorization_required",
        "gauge",
        "Whether a legacy elevated permission mode requires explicit reauthorization.",
        if migration.permission_reauthorization_required {
            1
        } else {
            0
        }
    );
    metric!(
        "mon_agent_process_uptime_seconds",
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

async fn blob_upload(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
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

async fn blob_read(
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

async fn rpc_upgrade(
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

fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|origin| state.allowed_origins.contains(origin))
}

fn token_matches(state: &AppState, headers: &HeaderMap) -> bool {
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

fn bearer_token_matches(state: &AppState, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    bearer.is_some_and(|token| token == state.capability_token.as_ref())
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let connection_id = Uuid::new_v4().to_string();
    let (mut sender, mut receiver) = socket.split();
    let mut notifications = state.runtime.subscribe();
    let mut initialized = false;

    loop {
        tokio::select! {
            frame = receiver.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        if process_client_text(
                            &mut sender,
                            &state,
                            &connection_id,
                            &mut initialized,
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
            event = notifications.recv(), if initialized => {
                let notification = match event {
                    Ok(event) => RpcNotification::new("session.event", session_event(event)),
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

async fn process_client_text(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
    connection_id: &str,
    initialized: &mut bool,
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
    let was_initialized = *initialized;
    let response = match request.method.as_str() {
        "initialize" if !*initialized => {
            match serde_json::from_value::<InitializeParams>(request.params) {
                Ok(params) if params.protocol_version == PROTOCOL_VERSION => {
                    *initialized = true;
                    RpcResponse::success(
                        id,
                        InitializeResult {
                            protocol_version: PROTOCOL_VERSION,
                            server_name: "mon-agent-server".to_owned(),
                            server_version: env!("CARGO_PKG_VERSION").to_owned(),
                            agent_core_version: mon_agent_core::VERSION.to_owned(),
                            capabilities: vec![
                                "session-events".to_owned(),
                                "permissions".to_owned(),
                                "durable-input".to_owned(),
                                "durable-workspace-switch".to_owned(),
                                "voice-tts".to_owned(),
                                "voice-stt-realtime".to_owned(),
                            ],
                        },
                    )
                }
                Ok(_) => RpcResponse::error(id, -32001, "unsupported protocol version"),
                Err(error) => {
                    RpcResponse::error(id, -32602, format!("invalid initialize params: {error}"))
                }
            }
        }
        "initialize" => RpcResponse::error(id, -32002, "connection is already initialized"),
        _ if !*initialized => {
            RpcResponse::error(id, -32000, "initialize must be the first request")
        }
        _ => match execute_method(state, &request.method, request.params).await {
            Ok(result) => RpcResponse::success(id, result),
            Err(failure) => RpcResponse::error(id, failure.code, failure.message),
        },
    };
    send_response(sender, response).await?;
    if *initialized && !was_initialized {
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

#[derive(Debug)]
struct RpcFailure {
    code: i32,
    message: String,
}

impl RpcFailure {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    fn application(message: impl Into<String>) -> Self {
        Self {
            code: -32010,
            message: message.into(),
        }
    }
}

async fn execute_method(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "ping" => Ok(json!({"pong": true})),
        "voice.tts.synthesize" => {
            let params: VoiceTtsSynthesizeParams = parse_params(params)?;
            if params.text.trim().is_empty() {
                return Err(RpcFailure::invalid_params("text is required"));
            }
            let session_id = params.session_id.to_string();
            let message_id = params.message_id.clone();
            state
                .store
                .get_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let response = state
                .host_services
                .synthesize_speech(
                    &session_id,
                    json!({
                        "external_session_id": session_id,
                        "external_message_id": params.message_id,
                        "segment_group_id": params.segment_group_id,
                        "group_index": params.group_index,
                        "sequence": params.sequence,
                        "text": params.text,
                        "config_id": params.config_id,
                        "mode": params.mode,
                    }),
                )
                .await
                .map_err(|error| {
                    warn!(
                        %error,
                        %session_id,
                        %message_id,
                        "Mon Core TTS synthesis request failed"
                    );
                    RpcFailure::application(error)
                })?;
            let mut response: VoiceTtsSynthesizeResult =
                serde_json::from_value(response).map_err(|error| {
                    RpcFailure::application(format!("invalid Mon Core TTS response: {error}"))
                })?;
            if let Some(source) = response.audio_url.as_deref() {
                response.audio_blob_id = Some(
                    cache_core_audio(state, &session_id, source)
                        .await
                        .map_err(|error| {
                            warn!(
                                error = %error.message,
                                %session_id,
                                %message_id,
                                "failed to cache Mon Core TTS audio"
                            );
                            error
                        })?,
                );
                response.audio_url = None;
            }
            serde_json::to_value(response)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "voice.tts.list_segments" => {
            let params: VoiceSpeechSegmentListParams = parse_params(params)?;
            let session_id = params.session_id.to_string();
            state
                .store
                .get_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let response = state
                .host_services
                .list_speech_segments(&session_id, params.message_id.as_deref())
                .await
                .map_err(RpcFailure::application)?;
            let mut response: Vec<VoiceSpeechSegmentInfo> = serde_json::from_value(response)
                .map_err(|error| {
                    RpcFailure::application(format!(
                        "invalid Mon Core speech segment response: {error}"
                    ))
                })?;
            for segment in &mut response {
                segment.audio_blob_id =
                    Some(cache_core_audio(state, &session_id, &segment.audio_url).await?);
                segment.audio_url.clear();
            }
            serde_json::to_value(response)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.create" => {
            let params: SessionCreateParams = parse_params(params)?;
            let environment = params
                .environment
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?
                .unwrap_or_else(|| json!({}));
            let session = state
                .store
                .create_session_with_environment(
                    params.title.trim(),
                    params
                        .participants
                        .into_iter()
                        .map(|participant| serde_json::to_value(participant).unwrap_or(Value::Null))
                        .collect(),
                    environment,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.list" => {
            let params: SessionListParams = parse_params(params)?;
            let mut sessions = if params.include_closed {
                state.store.list_sessions_including_closed().await
            } else {
                state.store.list_sessions().await
            }
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            sessions.truncate(params.limit.clamp(1, 500) as usize);
            serde_json::to_value(
                sessions
                    .into_iter()
                    .map(session_summary)
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.read" => {
            let params: SessionReadParams = parse_params(params)?;
            let session = state
                .store
                .get_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.rename" => {
            let params: SessionTitleParams = parse_params(params)?;
            let session = state
                .store
                .set_session_title(params.session_id, &params.title, "user")
                .await
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            state
                .core_sync
                .enqueue_session_snapshot(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.set_participants" => {
            let params: SessionParticipantsParams = parse_params(params)?;
            let session_id = params.session_id;
            ensure_session_model_mutable(state, session_id).await?;
            let session = state
                .store
                .set_session_participants(
                    session_id,
                    params
                        .participants
                        .into_iter()
                        .map(|participant| serde_json::to_value(participant).unwrap_or(Value::Null))
                        .collect(),
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state.models.remove_session(&session_id.to_string()).await;
            serde_json::to_value(session_summary(session))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "session.close" => {
            let params: SessionReadParams = parse_params(params)?;
            state
                .store
                .close_session(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state
                .core_sync
                .enqueue_session_snapshot(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            state
                .models
                .remove_session(&params.session_id.to_string())
                .await;
            Ok(json!({"sessionId": params.session_id, "closed": true}))
        }
        "session.delete" => {
            let params: SessionReadParams = parse_params(params)?;
            let restore_active = state
                .store
                .begin_session_deletion(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if let Err(error) = state
                .core_sync
                .delete_session_projection(params.session_id)
                .await
            {
                if restore_active {
                    let _ = state
                        .store
                        .restore_session_after_failed_delete(params.session_id)
                        .await;
                }
                return Err(RpcFailure::application(error.to_string()));
            }
            state.runtime.forget_session(params.session_id).await;
            let deleted = match state.store.delete_session(params.session_id).await {
                Ok(deleted) => deleted,
                Err(error) => {
                    if restore_active {
                        let _ = state
                            .store
                            .restore_session_after_failed_delete(params.session_id)
                            .await;
                    }
                    // The remote projection may already have been deleted. Re-enqueueing
                    // the restored local snapshot makes this compensating path convergent.
                    let _ = state
                        .core_sync
                        .enqueue_session_snapshot(params.session_id)
                        .await;
                    return Err(RpcFailure::application(error.to_string()));
                }
            };
            state
                .models
                .remove_session(&params.session_id.to_string())
                .await;
            state
                .host_services
                .unbind_session_core_credentials(&params.session_id.to_string())
                .await;
            Ok(json!({"sessionId":params.session_id,"deleted":deleted}))
        }
        "session.compact" => {
            let params: SessionCompactParams = parse_params(params)?;
            let enqueued = state
                .runtime
                .compact(params.session_id, params.instructions)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnAccepted {
                session_id: params.session_id,
                turn_id: enqueued.input.turn_id,
                input_id: enqueued.input.id,
                state: "queued".to_owned(),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.start" => {
            let params: TurnStartParams = parse_params(params)?;
            if params.text.trim().is_empty() && params.attachments.is_empty() {
                return Err(RpcFailure::invalid_params(
                    "turn requires text or at least one attachment",
                ));
            }
            if let Some(environment) = params.environment {
                state
                    .store
                    .set_session_environment(
                        params.session_id,
                        serde_json::to_value(environment)
                            .map_err(|error| RpcFailure::invalid_params(error.to_string()))?,
                    )
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
            }
            let enqueued = state
                .runtime
                .submit_turn(
                    params.session_id,
                    params.text,
                    serde_json::to_value(params.attachments)
                        .map_err(|error| RpcFailure::application(error.to_string()))?,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnAccepted {
                session_id: params.session_id,
                turn_id: enqueued.input.turn_id,
                input_id: enqueued.input.id,
                state: "queued".to_owned(),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.steer" | "turn.follow_up" => {
            let params: TurnQueueParams = parse_params(params)?;
            let text = params.text.trim();
            if text.is_empty() {
                return Err(RpcFailure::invalid_params("text is required"));
            }
            let update = if method == "turn.steer" {
                state
                    .runtime
                    .steer(params.session_id, text.to_owned())
                    .await
            } else {
                state
                    .runtime
                    .follow_up(params.session_id, text.to_owned())
                    .await
            }
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(TurnQueueResult {
                session_id: params.session_id,
                state: update.state.to_owned(),
                turn_id: update.input.as_ref().map(|input| input.input.turn_id),
                input_id: update.input.map(|input| input.input.id),
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "turn.cancel" => {
            let params: SessionReadParams = parse_params(params)?;
            state
                .runtime
                .cancel(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            Ok(json!({"sessionId": params.session_id, "cancellationRequested": true}))
        }
        "event.list" => {
            let params: EventListParams = parse_params(params)?;
            let page = state
                .store
                .list_event_page(params.session_id, params.after_seq, params.limit)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(EventPage {
                items: page
                    .items
                    .into_iter()
                    .map(session_event)
                    .collect::<Vec<_>>(),
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "message.list" => {
            let params: MessageListParams = parse_params(params)?;
            let page = state
                .store
                .list_message_event_page(params.session_id, params.before.as_deref(), params.limit)
                .await
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            serde_json::to_value(EventPage {
                items: page
                    .items
                    .into_iter()
                    .map(session_event)
                    .collect::<Vec<_>>(),
                next_cursor: page.next_cursor,
                has_more: page.has_more,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "director.list" => {
            let params: DirectorListParams = parse_params(params)?;
            let events = state
                .store
                .list_director_events(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(project_director_runs(events))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "permission.list" => {
            let params: PermissionListParams = parse_params(params)?;
            let permissions = state
                .approvals
                .list_pending(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .map(permission_info)
                .collect::<Vec<_>>();
            serde_json::to_value(permissions)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "permission.mode.get" => Ok(json!({"mode":state.approvals.mode().as_str()})),
        "permission.mode.set" => {
            let mode = params
                .get("mode")
                .and_then(Value::as_str)
                .and_then(SandboxPermissionMode::parse)
                .ok_or_else(|| {
                    RpcFailure::invalid_params("mode must be restricted, full_access, or takeover")
                })?;
            state
                .approvals
                .set_mode(mode)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            Ok(json!({"mode":mode.as_str()}))
        }
        "permission.resolve" => {
            let params: PermissionResolveParams = parse_params(params)?;
            let decision = match params.decision {
                PermissionDecision::Once => ApprovalDecision::Once,
                PermissionDecision::Always => ApprovalDecision::Always,
                PermissionDecision::Deny => ApprovalDecision::Deny,
            };
            let permission = state
                .approvals
                .resolve(params.request_id, decision, params.message)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(permission_info(permission))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "operation.list" => {
            let params: OperationListParams = parse_params(params)?;
            let operations = state
                .store
                .list_operations(params.session_id, params.state.as_deref(), params.limit)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .map(operation_info)
                .collect::<Vec<_>>();
            serde_json::to_value(operations)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "operation.resolve" => {
            let params: OperationResolveParams = parse_params(params)?;
            let operation = state
                .store
                .resolve_unknown_operation(
                    params.operation_id,
                    match params.decision {
                        OperationDecision::Retry => "retry",
                        OperationDecision::Abandon => "abandon",
                    },
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(operation_info(operation))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.list" => {
            let params: QuestionListParams = parse_params(params)?;
            let questions = state
                .questions
                .list_pending(params.session_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .map(question_info)
                .collect::<Result<Vec<_>, _>>()?;
            serde_json::to_value(questions)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.resolve" => {
            let params: QuestionResolveParams = parse_params(params)?;
            let question = state
                .questions
                .resolve(params.request_id, params.answers)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(question_info(question)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "question.reject" => {
            let params: QuestionRejectParams = parse_params(params)?;
            let question = state
                .questions
                .reject(params.request_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(question_info(question)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "media.list" => {
            let params: MediaListParams = parse_params(params)?;
            let records = state
                .media
                .list_pending(params.kind.as_deref())
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(records.into_iter().map(media_info).collect::<Vec<_>>())
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "media.resolve" => {
            let params: MediaResolveParams = parse_params(params)?;
            let id = Uuid::parse_str(&params.id)
                .map_err(|error| RpcFailure::invalid_params(error.to_string()))?;
            let record = state
                .media
                .resolve(id, params.result, params.error)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(media_info(record))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.list" => {
            let _: SkillListParams = parse_params(params)?;
            let skills = state
                .skills
                .list()
                .into_iter()
                .map(|skill| skill_info(&state.skills, skill, false))
                .collect::<Vec<_>>();
            serde_json::to_value(skills).map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.read" => {
            let params: SkillReadParams = parse_params(params)?;
            let skill = state.skills.get(&params.name).ok_or_else(|| {
                RpcFailure::application(format!("skill not found: {}", params.name))
            })?;
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.install" => {
            let params: SkillInstallParams = parse_params(params)?;
            let skill = state
                .skills
                .install(&params.name, &params.description, &params.content)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.enable" => {
            let params: SkillEnableParams = parse_params(params)?;
            let skill = state
                .skills
                .set_enabled(&params.name, params.enabled)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.uninstall" => {
            let params: SkillReadParams = parse_params(params)?;
            state
                .skills
                .uninstall(&params.name)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            Ok(json!({"deleted":true}))
        }
        "skill.inspect" => {
            let params: SkillInspectParams = parse_params(params)?;
            let source_type = params.source_type.as_str();
            let source = params.source_uri.as_str();
            let subpath = params.source_subpath.as_deref();
            let source_ref = params.source_ref.as_deref();
            let scope = params.scope.as_str();
            let (preview_id, skill) = match source_type {
                "local" => state.skills.inspect_local_for(
                    "rpc-local",
                    std::path::Path::new(source),
                    subpath,
                    scope,
                    "local",
                    None,
                ),
                "git" => {
                    state
                        .skills
                        .inspect_git_for("rpc-local", source, source_ref, subpath, scope)
                }
                other => {
                    return Err(RpcFailure::application(format!(
                        "unsupported skill source type: {other}"
                    )));
                }
            }
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(SkillPreviewInfo {
                preview_id,
                skill_name: skill.name,
                display_name: skill.display_name,
                description: skill.description,
                version: skill.version,
                scope: scope.to_owned(),
                source: SkillPreviewSource {
                    source_type: source_type.to_owned(),
                    uri: source.to_owned(),
                    source_ref: source_ref.unwrap_or("").to_owned(),
                    subpath: subpath.unwrap_or("").to_owned(),
                },
                tools: skill.tools,
                profiles: skill.profiles,
                model_invocable: !skill.disable_model_invocation,
                content_hash: skill.content_hash,
                file_count: u64::try_from(skill.files.len()).unwrap_or(u64::MAX),
                total_bytes: skill.total_bytes,
                expires_at: chrono::Utc::now().timestamp_millis() + 900_000,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.install_preview" => {
            let params: SkillPreviewInstallParams = parse_params(params)?;
            let skill = state
                .skills
                .install_preview_for("rpc-local", &params.preview_id)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
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
            serde_json::to_value(agent_info(agent)?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "agent.interrupt" => {
            let params: AgentReadParams = parse_params(params)?;
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
                .create_memo(mon_agent_store::MemoInput {
                    title: params.title,
                    content: params.content,
                    kind: params.kind,
                    status: params.status,
                    priority: params.priority,
                    remind_at: params.remind_at,
                    due_at: params.due_at,
                    repeat_rule: params.repeat_rule,
                    source: "monagent".to_owned(),
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

fn project_director_runs(events: Vec<EventRecord>) -> Vec<DirectorRunInfo> {
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

async fn ensure_session_model_mutable(
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

async fn configure_session_actor_models(
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

async fn session_model_identity(
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

async fn persist_session_model_binding(
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

fn json_id(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => String::new(),
    }
}

async fn workspace_target(
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

fn memo_info(memo: mon_agent_store::MemoRecord) -> MemoInfo {
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

fn connector_info(connector: mon_agent_store::ConnectorRecord) -> ConnectorInfo {
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

fn media_info(record: mon_agent_store::MediaRequestRecord) -> MediaRequestInfo {
    MediaRequestInfo {
        id: record.id.to_string(),
        session_id: record.session_id,
        kind: record.kind,
        state: record.state,
        request: record.request,
        created_at: record.created_at,
    }
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, RpcFailure> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params)
        .map_err(|error| RpcFailure::invalid_params(format!("invalid params: {error}")))
}

fn session_summary(record: SessionRecord) -> SessionSummary {
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
            mon_agent_store::SessionStatus::Active => SessionStatus::Active,
            mon_agent_store::SessionStatus::Closed => SessionStatus::Closed,
        },
        participants,
        environment: serde_json::from_value::<SessionEnvironment>(record.environment).ok(),
        context_tokens,
        token_breakdown,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn session_event(event: mon_agent_store::EventRecord) -> SessionEvent {
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

fn permission_info(permission: mon_agent_store::PermissionRecord) -> PermissionRequestInfo {
    PermissionRequestInfo {
        id: permission.id,
        session_id: permission.session_id,
        turn_id: permission.turn_id,
        operation_id: permission.operation_id,
        capability: permission.capability,
        resource: permission.resource,
        state: match permission.state {
            mon_agent_store::PermissionState::Pending => "pending",
            mon_agent_store::PermissionState::Allowed => "allowed",
            mon_agent_store::PermissionState::Denied => "denied",
            mon_agent_store::PermissionState::Expired => "expired",
        }
        .to_owned(),
        request: permission.request,
        created_at: permission.created_at,
    }
}

fn operation_info(operation: mon_agent_store::OperationJournalRecord) -> OperationInfo {
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

fn question_info(
    question: mon_agent_store::QuestionRecord,
) -> Result<QuestionRequestInfo, RpcFailure> {
    let questions = serde_json::from_value(question.questions).map_err(|error| {
        RpcFailure::application(format!("invalid stored question payload: {error}"))
    })?;
    Ok(QuestionRequestInfo {
        id: question.id,
        session_id: question.session_id,
        turn_id: question.turn_id,
        state: match question.state {
            mon_agent_store::QuestionState::Pending => "pending",
            mon_agent_store::QuestionState::Answered => "answered",
            mon_agent_store::QuestionState::Rejected => "rejected",
            mon_agent_store::QuestionState::Expired => "expired",
        }
        .to_owned(),
        questions,
        created_at: question.created_at,
    })
}

fn agent_info(agent: mon_agent_store::AgentThreadRecord) -> Result<AgentThreadInfo, RpcFailure> {
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

fn native_tool_registry(
    workspaces: &WorkspaceService,
    command_tools_enabled: bool,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    for (name, description, parameters, sequential) in [
        (
            "read",
            "Read a UTF-8 file or supported image inside the workspace",
            json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "ls",
            "List a directory inside the workspace",
            json!({"type":"object","properties":{"path":{"type":"string"}}}),
            false,
        ),
        (
            "find",
            "Find files by glob inside the workspace",
            json!({"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "grep",
            "Search file contents inside the workspace",
            json!({"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"},"glob":{"type":"string"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "get_diff",
            "Read a bounded preview of the current Git diff without changing files; narrow path for large diffs",
            json!({"type":"object","properties":{"path":{"type":"string"},"scope":{"type":"string","enum":["working_tree","staged","all"]},"max_chars":{"type":"integer","minimum":1000,"maximum":12000}}}),
            false,
        ),
        (
            "write",
            "Write a file inside the workspace after approval",
            json!({"type":"object","required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"}}}),
            true,
        ),
        (
            "edit",
            "Apply exact text replacements inside the workspace after approval",
            json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"edits":{"type":"array"}}}),
            true,
        ),
        (
            "apply_patch",
            "Apply a structured file patch inside the workspace after approval",
            json!({"type":"object","required":["patch"],"properties":{"patch":{"type":"string"}}}),
            true,
        ),
    ] {
        let mut definition = ToolDefinition::direct(name, description);
        definition.parameters = parameters;
        if sequential {
            definition.execution_mode = ToolExecutionMode::Sequential;
        }
        if let Some(tool) = workspaces.native_tool(definition) {
            registry.register(tool);
        }
    }
    if command_tools_enabled {
        let command_definitions = if cfg!(windows) {
            vec![(
                "powershell",
                "Run a PowerShell command in the configured OS sandbox",
                json!({"type":"object","required":["command"],"properties":{"command":{"type":"string"},"yield_time_ms":{"type":"integer"}}}),
            )]
        } else {
            vec![(
                "bash",
                "Run a Bash command in the configured OS sandbox",
                json!({"type":"object","required":["command"],"properties":{"command":{"type":"string"},"yield_time_ms":{"type":"integer"}}}),
            )]
        };
        for (name, description, parameters) in command_definitions {
            let mut definition = ToolDefinition::direct(name, description);
            definition.parameters = parameters;
            definition.execution_mode = ToolExecutionMode::Sequential;
            if let Some(tool) = workspaces.native_tool(definition) {
                registry.register(tool);
            }
        }
        let mut definition = ToolDefinition::direct(
            "write_stdin",
            "Poll, write to, or terminate a sandboxed process session",
        );
        definition.parameters = json!({"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"},"chars":{"type":"string"},"terminate":{"type":"boolean"},"yield_time_ms":{"type":"integer"}}});
        definition.execution_mode = ToolExecutionMode::Sequential;
        if let Some(tool) = workspaces.native_tool(definition) {
            registry.register(tool);
        }
    }
    registry
}

fn resolve_process_sandbox(configured: Option<&std::path::Path>) -> ProcessSandbox {
    if let Some(executable) = configured.filter(|path| path.is_file()) {
        return ProcessSandbox::External(executable.to_owned());
    }
    #[cfg(target_os = "linux")]
    if let Some(executable) = find_path_executable("bwrap") {
        return ProcessSandbox::Bubblewrap(executable);
    }
    ProcessSandbox::Disabled
}

#[cfg(target_os = "linux")]
fn find_path_executable(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

async fn send_response(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    response: RpcResponse,
) -> Result<(), axum::Error> {
    send_json(sender, &response).await
}

async fn send_json(
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

async fn resolve_capability_token(
    configured: Option<String>,
    token_file: &PathBuf,
) -> Result<String> {
    if let Some(token) = configured.filter(|token| token.len() >= 32) {
        return Ok(token);
    }
    if let Ok(token) = fs::read_to_string(token_file).await {
        let token = token.trim().to_owned();
        if token.len() >= 32 {
            return Ok(token);
        }
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    if let Some(parent) = token_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(token_file, format!("{token}\n"))
        .await
        .with_context(|| {
            format!(
                "failed to write capability token to {}",
                token_file.display()
            )
        })?;
    Ok(token)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[test]
    fn assistant_handoff_only_parks_for_missing_session_credentials() {
        let unavailable: anyhow::Error =
            CoreSyncError::CredentialUnavailable("core:opaque".to_owned()).into();
        assert!(assistant_handoff_waits_for_core_credential(&unavailable));

        let request: anyhow::Error = CoreSyncError::Request("offline".to_owned()).into();
        assert!(!assistant_handoff_waits_for_core_credential(&request));
    }

    async fn test_state() -> AppState {
        let store = Store::in_memory().await.expect("store");
        let core_sync = CoreSyncService::new(store.clone()).expect("Core sync");
        let runtime = SessionRuntime::new(
            store.clone(),
            model_spec_from_env(),
            Arc::new(UnavailableProvider::new("test provider is unavailable")),
            ToolRegistry::new(),
            "test",
        );
        let approvals =
            ApprovalService::new(store.clone(), PermissionPolicy::new(PolicyEffect::Ask));
        let questions = QuestionService::new(store.clone());
        let blob_directory = tempfile::tempdir().expect("blob tempdir").keep();
        let blobs = BlobService::new(blob_directory, store.clone(), 32 * 1024 * 1024)
            .await
            .expect("blobs");
        let media = MediaService::new(store.clone(), blobs.clone());
        let skill_directory = tempfile::tempdir().expect("skill tempdir").keep();
        let skills = SkillCatalog::discover(&[], skill_directory).expect("skills");
        let workspace_directory = tempfile::tempdir().expect("workspace tempdir").keep();
        let workspaces = WorkspaceService::initialize(
            store.clone(),
            workspace_directory,
            ProcessSandbox::Disabled,
        )
        .await
        .expect("workspaces");
        let connectors = ConnectorService::new(store.clone()).expect("connectors");
        let host_services = HostServices::new(store.clone(), None, None).expect("host services");
        let multiagents = MultiAgentService::new(
            store.clone(),
            model_spec_from_env(),
            Arc::new(UnavailableProvider::new("test")),
            ToolRegistry::new(),
            Arc::new(approvals.clone()),
            "test",
            1,
        );
        AppState {
            capability_token: Arc::from("0123456789abcdef0123456789abcdef"),
            allowed_origins: Arc::new(HashSet::from(["http://localhost:40091".to_owned()])),
            store,
            runtime,
            approvals,
            questions,
            media,
            blobs,
            skills,
            connectors,
            multiagents,
            workspaces,
            tool_registry: ToolRegistry::new(),
            host_services,
            models: DynamicModelProvider::from_env(),
            core_models: CoreModelClient::new().expect("Core model client"),
            core_sync,
            diagnostics: Arc::new(RuntimeDiagnostics::new(false)),
        }
    }

    #[tokio::test]
    async fn health_exposes_directly_linked_core_version() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::get("/healthz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .expect("health body");
        let value: Value = serde_json::from_slice(&bytes).expect("health JSON");
        assert_eq!(value["agentCoreVersion"], mon_agent_core::VERSION);
        assert_eq!(value["protocolVersion"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn readiness_reports_required_runtime_failures_separately_from_liveness() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::get("/readyz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("readiness body");
        let value: Value = serde_json::from_slice(&bytes).expect("readiness JSON");
        assert_eq!(value["status"], "not_ready");
        assert_eq!(value["checks"]["toolRegistry"]["ready"], false);
        assert_eq!(value["checks"]["legacyMigrationAudit"]["ready"], true);
        assert_eq!(value["checks"]["processSandbox"]["required"], false);
    }

    #[tokio::test]
    async fn metrics_exposes_durable_queue_and_latency_series() {
        let response = build_router(test_state().await)
            .oneshot(
                Request::get("/metrics")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("metrics body");
        let body = String::from_utf8(bytes.to_vec()).expect("metrics UTF-8");
        assert!(body.contains("mon_agent_active_sessions"));
        assert!(body.contains("mon_agent_first_token_seconds_sum"));
        assert!(body.contains("mon_agent_provider_retries_total"));
        assert!(body.contains("mon_agent_database_scrape_latency_seconds"));
        assert!(body.contains("mon_agent_legacy_skill_reinstalls_pending"));
        assert!(body.contains("mon_agent_legacy_permission_reauthorization_required"));
    }

    #[tokio::test]
    async fn workspace_switch_rpc_persists_a_validated_pending_request() {
        let state = test_state().await;
        let session = state
            .store
            .create_session("workspace")
            .await
            .expect("session");
        let target = tempfile::tempdir().expect("target workspace").keep();
        let result = execute_method(
            &state,
            "workspace.switch",
            json!({"sessionId":session.id,"path":target}),
        )
        .await
        .expect("workspace switch");
        let target_text = target.to_string_lossy().into_owned();
        assert_eq!(result["pendingPath"].as_str(), Some(target_text.as_str()));
        let persisted = state.workspaces.state().await.expect("workspace state");
        assert_eq!(persisted.pending_session_id, Some(session.id));
        assert_eq!(
            persisted.pending_path.as_deref(),
            Some(target_text.as_str())
        );
    }

    #[tokio::test]
    async fn catalog_worker_applies_workspace_only_after_idle_validation() {
        let state = test_state().await;
        let session = state
            .store
            .create_session("workspace-worker")
            .await
            .expect("session");
        let target = tempfile::tempdir().expect("target workspace").keep();
        state
            .workspaces
            .request_switch(session.id, &target)
            .await
            .expect("request switch");
        let worker = spawn_catalog_worker(
            state.skills.clone(),
            state.runtime.clone(),
            state.multiagents.clone(),
            state.workspaces.clone(),
            WorkspaceSkillRoots {
                configured: Arc::new(Vec::new()),
                startup_root: Arc::new(std::env::current_dir().expect("cwd")),
            },
            Arc::clone(&state.diagnostics.catalog_heartbeat),
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let persisted = state.workspaces.state().await.expect("workspace state");
                if persisted.pending_path.is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("workspace switch timeout");
        worker.abort();
        assert_eq!(state.workspaces.current_root(), target);
    }

    #[tokio::test]
    async fn rpc_rejects_missing_capability_token() {
        assert!(!token_matches(&test_state().await, &HeaderMap::new()));
    }

    #[tokio::test]
    async fn rpc_rejects_untrusted_origin_before_upgrade() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            "https://attacker.example".parse().expect("header"),
        );
        assert!(!origin_allowed(&test_state().await, &headers));
    }

    #[tokio::test]
    async fn websocket_subprotocol_can_carry_browser_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            format!("{WEBSOCKET_PROTOCOL}, mon-agent-token.0123456789abcdef0123456789abcdef")
                .parse()
                .expect("header"),
        );
        assert!(token_matches(&test_state().await, &headers));
    }

    #[test]
    fn command_line_configuration_parses_typed_long_term_server_settings() {
        let args = Args::try_parse_from([
            "mon-agent-server",
            "--bind",
            "127.0.0.1:41092",
            "--database",
            "state/agent.db",
            "--log-directory",
            "state/logs",
            "--log-max-bytes",
            "2048",
            "--log-max-files",
            "3",
            "--workspace-root",
            "workspace",
            "--skill-roots",
            "builtin,project",
            "--core-base-url",
            "http://127.0.0.1:40011",
            "--allowed-origins",
            "http://127.0.0.1:40091,monagent://app",
        ])
        .expect("typed configuration");
        assert_eq!(args.bind, "127.0.0.1:41092".parse().expect("socket"));
        assert_eq!(args.database, PathBuf::from("state/agent.db"));
        assert_eq!(args.log_directory, PathBuf::from("state/logs"));
        assert_eq!(args.log_max_bytes, 2048);
        assert_eq!(args.log_max_files, 3);
        assert_eq!(args.workspace_root, PathBuf::from("workspace"));
        assert_eq!(
            args.skill_roots,
            vec![PathBuf::from("builtin"), PathBuf::from("project")]
        );
        assert_eq!(
            args.core_base_url.as_deref(),
            Some("http://127.0.0.1:40011")
        );
        assert_eq!(
            args.allowed_origins,
            vec![
                "http://127.0.0.1:40091".to_owned(),
                "monagent://app".to_owned()
            ]
        );
        assert!(Args::try_parse_from(["mon-agent-server", "--log-max-files", "many"]).is_err());
        assert!(
            Args::try_parse_from(["mon-agent-server", "--bind", "0.0.0.0:not-a-port"]).is_err()
        );
    }

    #[tokio::test]
    async fn permission_mode_rpc_persists_before_returning() {
        let state = test_state().await;
        let changed = execute_method(&state, "permission.mode.set", json!({"mode":"takeover"}))
            .await
            .expect("set permission mode");
        assert_eq!(changed["mode"], "takeover");
        assert_eq!(
            state
                .store
                .get_config("permission.mode")
                .await
                .expect("persisted mode"),
            Some(json!("takeover"))
        );
        let read = execute_method(&state, "permission.mode.get", json!({}))
            .await
            .expect("read permission mode");
        assert_eq!(read["mode"], "takeover");
        let invalid = execute_method(
            &state,
            "permission.mode.set",
            json!({"mode":"unrestricted"}),
        )
        .await
        .expect_err("invalid permission mode must fail");
        assert_eq!(invalid.code, -32602);
    }

    #[tokio::test]
    async fn participant_rpc_rejects_a_busy_session_without_mutating_it() {
        let state = test_state().await;
        let session = state
            .store
            .create_session_with_participants(
                "participants",
                vec![json!({"assistantId":1,"assistantName":"One","position":0})],
            )
            .await
            .expect("session");
        state
            .store
            .enqueue_input(
                session.id,
                mon_agent_core::TurnId::new(),
                json!({"text":"busy"}),
            )
            .await
            .expect("queued input");
        let error = execute_method(
            &state,
            "session.set_participants",
            json!({
                "sessionId":session.id,
                "participants":[{"assistantId":2,"assistantName":"Two","position":0}]
            }),
        )
        .await
        .expect_err("busy session must reject participant replacement");
        assert_eq!(error.code, -32010);
        let persisted = state.store.get_session(session.id).await.expect("session");
        assert_eq!(persisted.participants[0]["assistantId"], 1);
    }

    #[tokio::test]
    async fn manual_compaction_rpc_uses_the_durable_input_queue() {
        let state = test_state().await;
        let session = state
            .store
            .create_session("compact")
            .await
            .expect("session");
        let accepted = execute_method(
            &state,
            "session.compact",
            json!({"sessionId":session.id,"instructions":"preserve decisions"}),
        )
        .await
        .expect("compact session");
        let accepted: TurnAccepted = serde_json::from_value(accepted).expect("turn accepted");
        assert_eq!(accepted.session_id, session.id);
        assert_eq!(accepted.state, "queued");
        let events = state
            .store
            .list_events(session.id, 0)
            .await
            .expect("events");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "input.admitted")
        );
    }

    #[tokio::test]
    async fn connector_rpc_uses_manifest_catalog_and_rejects_unknown_types() {
        let state = test_state().await;
        let catalog = execute_method(&state, "connector.catalog", json!({}))
            .await
            .expect("connector catalog");
        assert!(
            catalog["connectors"]
                .as_array()
                .is_some_and(|entries| entries.iter().any(|entry| entry["key"] == "lichess"))
        );

        let unknown = execute_method(
            &state,
            "connector.create",
            json!({
                "connectorKey":"uninstalled",
                "identityKey":"test",
                "displayName":"Unknown",
                "desiredState":"disconnected",
                "settings":{}
            }),
        )
        .await
        .expect_err("unknown connector must fail closed");
        assert_eq!(unknown.code, -32602);

        let created = execute_method(
            &state,
            "connector.create",
            json!({
                "connectorKey":"lichess",
                "identityKey":"test-account",
                "displayName":"Test Lichess",
                "desiredState":"disconnected",
                "settings":{}
            }),
        )
        .await
        .expect("create manifest-backed connector");
        assert_eq!(created["connectorKey"], "lichess");
        assert_eq!(created["desiredState"], "disconnected");

        let invalid_update = execute_method(
            &state,
            "connector.update",
            json!({"id":created["id"],"patch":{"settings":{"baseUrl":7}}}),
        )
        .await
        .expect_err("invalid connector settings must fail before persistence");
        assert_eq!(invalid_update.code, -32602);
    }

    #[tokio::test]
    async fn session_and_turn_rpc_use_the_durable_store() {
        let state = test_state().await;
        let created = execute_method(&state, "session.create", json!({"title": "first"}))
            .await
            .expect("create session");
        let session: SessionSummary = serde_json::from_value(created).expect("session response");

        let accepted = execute_method(
            &state,
            "turn.start",
            json!({"sessionId": session.id, "text": "hello", "attachments": []}),
        )
        .await
        .expect("start turn");
        let accepted: TurnAccepted = serde_json::from_value(accepted).expect("turn response");
        assert_eq!(accepted.session_id, session.id);
        assert_eq!(accepted.state, "queued");

        let events = execute_method(
            &state,
            "event.list",
            json!({"sessionId": session.id, "afterSeq": 0}),
        )
        .await
        .expect("list events");
        let events: EventPage = serde_json::from_value(events).expect("event response");
        assert!(
            events
                .items
                .iter()
                .any(|event| event.event_type == "input.admitted")
        );

        let listed = execute_method(&state, "session.list", json!({"limit": 10}))
            .await
            .expect("list sessions");
        let listed: Vec<SessionSummary> = serde_json::from_value(listed).expect("session list");
        assert_eq!(listed.len(), 1);

        execute_method(&state, "session.close", json!({"sessionId": session.id}))
            .await
            .expect("close session");
        let closed = state
            .store
            .get_session(session.id)
            .await
            .expect("closed session");
        assert_eq!(closed.status, mon_agent_store::SessionStatus::Closed);
    }
}
