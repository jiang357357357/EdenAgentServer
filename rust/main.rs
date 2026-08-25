mod jobs;
mod observability;
mod plugins;
mod rpc;
mod rpc_conversation;
mod rpc_extensions;
mod rpc_interaction;
mod rpc_runtime;
mod rpc_support;
mod rpc_voice;
mod tools;
mod transport;
mod voice;

use jobs::*;
use plugins::*;
use rpc::*;
use rpc_conversation::*;
use rpc_extensions::*;
use rpc_interaction::*;
use rpc_runtime::*;
use rpc_support::*;
use rpc_voice::*;
use tools::*;
use transport::*;
use voice::*;

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
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use clap::Parser;
use eden_agent_api::{
    AgentListParams, AgentMessageParams, AgentReadParams, AgentThreadInfo, AgentThreadResultInfo,
    AgentThreadStatus, BlobInfo, ConnectorCatalogInfo, ConnectorCreateParams, ConnectorInfo,
    ConnectorUpdateParams, DirectorBeatInfo, DirectorExecutionInfo, DirectorListParams,
    DirectorRunInfo, DirectorRunStatus, DirectorSceneInfo, EventListParams, EventPage,
    GsvConnectionTestResult, GsvDiscoveryParams, GsvDiscoveryResult, GsvDiscoveryStage, GsvOption,
    GsvPreviewParams, GsvPreviewResult, GsvSttConfig, GsvSttTestParams, GsvTtsConfig,
    InitializeParams, InitializeResult, JSON_RPC_VERSION, MediaListParams, MediaRequestInfo,
    MediaResolveParams, MemoCreateParams, MemoIdParams, MemoInfo, MemoListParams, MemoUpdateParams,
    MessageListParams, ModelCatalogParams, ModelReadParams, ModelSelectParams, OperationDecision,
    OperationInfo, OperationListParams, OperationResolveParams, PROTOCOL_VERSION,
    PermissionDecision, PermissionListParams, PermissionRequestInfo, PermissionResolveParams,
    PluginActivateParams, PluginComponentInfo, PluginEnableParams, PluginInfo, PluginInspectParams,
    PluginListParams, PluginMarketInspectParams, PluginMarketListParams, PluginMarketReleaseInfo,
    PluginMarketSourceAddParams, PluginMarketSourceInfo, PluginMarketSourceParams,
    PluginPermissionGrantInfo, PluginPermissionInfo, PluginPermissionSetParams, PluginPreviewInfo,
    PluginPreviewInstallParams, PluginReadParams, PluginUiContributionInfo, PluginUninstallResult,
    PluginVersionInfo, ProtocolSchemaCatalog, QuestionListParams, QuestionRejectParams,
    QuestionRequestInfo, QuestionResolveParams, ReadyNotification, RpcNotification, RpcRequest,
    RpcResponse, RuntimeModelCatalogInfo, RuntimeModelInfo, RuntimeOrigin, SelfAwakeDiaryInfo,
    SelfAwakeListParams, SelfAwakePage, SelfAwakeRunInfo, SessionCompactParams,
    SessionCreateParams, SessionEnvironment, SessionEvent, SessionListParams,
    SessionParticipantsParams, SessionReadParams, SessionStatus, SessionSummary,
    SessionTitleParams, SkillEnableParams, SkillInfo, SkillInspectParams, SkillInstallParams,
    SkillListParams, SkillPreviewInfo, SkillPreviewInstallParams, SkillPreviewSource,
    SkillReadParams, TOKEN_PROTOCOL_PREFIX, ToolInfo, TurnAccepted, TurnQueueParams,
    TurnQueueResult, TurnStartParams, VoiceRuntimeConfig, VoiceSpeechSegmentInfo,
    VoiceSpeechSegmentListParams, VoiceTtsSynthesizeParams, VoiceTtsSynthesizeResult,
    WEBSOCKET_PROTOCOL, WorkspaceDirectoryInfo, WorkspaceEntryInfo, WorkspaceEntryKind,
    WorkspaceFileInfo, WorkspaceInfo, WorkspacePathParams, WorkspaceSwitchParams,
};
use eden_agent_app::SessionRuntime;
use eden_agent_blob::BlobService;
use eden_agent_connector_package::{
    LoadPolicy as ConnectorPackageLoadPolicy, LoadedPackage as LoadedConnectorPackage,
};
use eden_agent_connectors::{ConnectorPermissionGrant, ConnectorService, PluginConnectorPackage};
use eden_agent_core::{ModelAdapter, SessionId, ToolDefinition, ToolExecutionMode, ToolRegistry};
use eden_agent_core_sync::{CoreSyncError, CoreSyncService};
use eden_agent_host::HostServices;
use eden_agent_interaction::{MediaService, QuestionService};
use eden_agent_market::{
    MarketIndexEnvelope, MarketRevocation, MarketplaceClient, VerifiedMarketIndex, verify_index,
};
use eden_agent_mcp::{McpComponentConfig, McpManager, McpRuntimeKind};
use eden_agent_multiagent::{MultiAgentService, SubagentCatalog};
use eden_agent_plugins::{
    LoadPolicy as PluginLoadPolicy, LoadedPlugin, ManagedInstallPreview, PluginInstaller,
    PluginManifest, RuntimeKind,
};
use eden_agent_provider::{CoreModelClient, DynamicModelProvider};
#[cfg(test)]
use eden_agent_provider::{UnavailableProvider, model_spec_from_env};
use eden_agent_sandbox::{
    ApprovalDecision, ApprovalService, PermissionMode as SandboxPermissionMode, PermissionPolicy,
    PolicyEffect,
};
use eden_agent_skills::{SkillCatalog, SkillDefinition};
use eden_agent_store::{
    EventRecord, PluginInstallRecord, PluginMarketRevocationInput, PluginMarketSourceRecord,
    PluginPermissionGrantInput, PluginPermissionGrantRecord, PluginRecord, SessionRecord,
    SessionRuntimeOrigin, Store,
};
use eden_agent_tools::ProcessSandbox;
use eden_agent_workspace::WorkspaceService;
use futures::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::SocketAddr,
    path::{Component, Path as StdPath, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::fs;
use tokio_tungstenite::{connect_async, tungstenite::Message as UpstreamMessage};
use tokio_util::sync::CancellationToken;
use tower_http::{limit::RequestBodyLimitLayer, trace::TraceLayer};
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(
    name = "eden-agent-server",
    version,
    about = "Eden Agent local Rust server"
)]
struct Args {
    #[arg(long, env = "EDEN_AGENT_BIND", default_value = "127.0.0.1:40092")]
    bind: SocketAddr,

    #[arg(long, env = "EDEN_AGENT_CAPABILITY_TOKEN")]
    capability_token: Option<String>,

    #[arg(
        long,
        env = "EDEN_AGENT_RUNTIME_ORIGIN",
        default_value = "mon",
        value_parser = ["mon", "local"]
    )]
    runtime_origin: String,

    #[arg(
        long,
        env = "EDEN_AGENT_TOKEN_FILE",
        default_value = "Data/server-capability.token"
    )]
    token_file: PathBuf,

    #[arg(long, env = "EDEN_AGENT_REALM_MIGRATION_MARKER")]
    realm_migration_marker: Option<PathBuf>,

    #[arg(
        long,
        env = "EDEN_AGENT_DATABASE",
        default_value = "Data/eden-agent.db"
    )]
    database: PathBuf,

    #[arg(long, env = "EDEN_AGENT_LOG_DIRECTORY", default_value = "Data/logs")]
    log_directory: PathBuf,

    #[arg(
        long,
        env = "EDEN_AGENT_LOG_MAX_BYTES",
        default_value_t = 10 * 1024 * 1024
    )]
    log_max_bytes: u64,

    #[arg(long, env = "EDEN_AGENT_LOG_MAX_FILES", default_value_t = 5)]
    log_max_files: usize,

    #[arg(
        long,
        env = "EDEN_AGENT_LEGACY_CORE_DATABASE",
        default_value = "../Core/Data/DB/SQLite/db.sqlite3"
    )]
    legacy_core_database: PathBuf,

    #[arg(long, env = "EDEN_AGENT_BLOB_ROOT", default_value = "Data/blobs")]
    blob_root: PathBuf,

    #[arg(long, env = "EDEN_AGENT_MAX_BLOB_BYTES", default_value_t = 32 * 1024 * 1024)]
    max_blob_bytes: usize,

    #[arg(long, env = "EDEN_AGENT_WORKSPACE_ROOT", default_value = ".")]
    workspace_root: PathBuf,

    #[arg(
        long,
        env = "EDEN_AGENT_SKILL_ROOTS",
        value_delimiter = ',',
        default_value = "Server/skills/builtin,.agents/skills"
    )]
    skill_roots: Vec<PathBuf>,

    #[arg(
        long,
        env = "EDEN_AGENT_SKILL_INSTALL_ROOT",
        default_value = "Data/skills"
    )]
    skill_install_root: PathBuf,

    #[arg(long, env = "EDEN_AGENT_PLUGIN_ROOT", default_value = "Data/plugins")]
    plugin_root: PathBuf,

    #[arg(long, env = "EDEN_AGENT_SANDBOX_EXECUTABLE")]
    sandbox_executable: Option<PathBuf>,

    #[arg(long, env = "MON_CORE_BASE_URL")]
    core_base_url: Option<String>,

    #[arg(long, env = "MON_CORE_TOKEN")]
    core_token: Option<String>,

    #[arg(
        long,
        env = "EDEN_AGENT_ALLOWED_ORIGINS",
        value_delimiter = ',',
        default_value = "http://127.0.0.1:40091,http://localhost:40091,edenagent://app"
    )]
    allowed_origins: Vec<String>,

    #[arg(long)]
    print_protocol_schema: bool,
}

#[derive(Clone)]
struct AppState {
    runtime_origin: RuntimeOrigin,
    capability_token: Arc<str>,
    allowed_origins: Arc<HashSet<String>>,
    store: Store,
    runtime: SessionRuntime,
    approvals: ApprovalService,
    questions: QuestionService,
    media: MediaService,
    blobs: BlobService,
    plugins: PluginInstaller,
    skills: SkillCatalog,
    connectors: ConnectorService,
    mcp: McpManager,
    marketplace: MarketplaceClient,
    plugin_hooks: PluginHookCatalog,
    multiagents: MultiAgentService,
    workspaces: WorkspaceService,
    tool_registry: ToolRegistry,
    host_services: HostServices,
    models: DynamicModelProvider,
    core_models: CoreModelClient,
    core_sync: CoreSyncService,
    diagnostics: Arc<RuntimeDiagnostics>,
}

const GSV_TTS_CONFIG_KEY: &str = "voice.gsv.tts";
const GSV_STT_CONFIG_KEY: &str = "voice.gsv.stt";

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
                    matches!(component, Component::Normal(name) if name == ".agents" || name == ".edenagent")
                }) {
                    workspace_root.join(root)
                } else {
                    self.startup_root.join(root)
                }
            })
            .collect()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let runtime_origin = match args.runtime_origin.as_str() {
        "mon" => RuntimeOrigin::Mon,
        "local" => RuntimeOrigin::Local,
        value => anyhow::bail!("unsupported runtime origin: {value}"),
    };
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
    let allow_migration_rebind = if let Some(marker) = args.realm_migration_marker.as_ref() {
        fs::read_to_string(marker)
            .await
            .is_ok_and(|value| value.trim() == args.runtime_origin)
    } else {
        false
    };
    let removed_foreign_sessions = store
        .bind_runtime_origin(store_origin(runtime_origin), allow_migration_rebind)
        .await
        .context("bind database to runtime origin")?;
    if let Some(marker) = args
        .realm_migration_marker
        .as_ref()
        .filter(|_| allow_migration_rebind)
    {
        let completed = marker.with_file_name(".realm-migration-complete");
        fs::write(&completed, format!("{}\n", args.runtime_origin)).await?;
        fs::remove_file(marker).await?;
    }
    if removed_foreign_sessions > 0 {
        info!(
            removed_foreign_sessions,
            runtime_origin = ?runtime_origin,
            "removed sessions from the other runtime during realm migration"
        );
    }
    initialize_voice_config(&store).await?;
    let plugins = PluginInstaller::open(&args.plugin_root)?;
    let marketplace = MarketplaceClient::new(args.plugin_root.join("market-cache"))
        .map_err(anyhow::Error::msg)?;
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
    hydrate_plugin_skills(&store, &skills).await?;
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
    hydrate_plugin_connectors(&store, &connectors).await?;
    for tool in connectors.tools() {
        tools.register(tool);
    }
    let mcp = McpManager::new(process_sandbox.clone(), workspace_root.clone());
    hydrate_plugin_mcp(&store, &mcp).await?;
    tools.register_dynamic_source(Arc::new(mcp.clone()));
    let plugin_hooks = PluginHookCatalog::default();
    hydrate_plugin_hooks(&store, &plugin_hooks).await?;
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
    eden_agent_core::validate_tool_definitions(&registered_tool_definitions)
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
    let plugin_hook_worker = spawn_plugin_hook_worker(store.clone(), plugin_hooks.clone());
    let core_sync_worker = tokio::spawn(core_sync.clone().run_with_heartbeat(
        CancellationToken::new(),
        Arc::clone(&diagnostics.core_sync_heartbeat),
    ));
    let connector_supervisor =
        connectors.start_with_heartbeat(Arc::clone(&diagnostics.connector_heartbeat));
    let state = AppState {
        runtime_origin,
        capability_token: Arc::from(capability_token),
        allowed_origins: Arc::new(args.allowed_origins.into_iter().collect()),
        store,
        runtime: runtime.clone(),
        approvals,
        questions,
        media,
        blobs,
        plugins,
        skills,
        connectors: connectors.clone(),
        mcp,
        marketplace,
        plugin_hooks,
        multiagents,
        workspaces,
        tool_registry,
        host_services,
        models,
        core_models,
        core_sync,
        diagnostics,
    };
    let plugin_market_refresh_worker = spawn_plugin_market_refresh_worker(state.clone());
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind {}", args.bind))?;
    info!(
        address = %args.bind,
        runtime_origin = ?runtime_origin,
        token_file = %args.token_file.display(),
        database = %args.database.display(),
        workspace = %workspace_root.display(),
        "Eden Agent Rust server listening"
    );
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server failed");
    runtime.shutdown().await;
    jobs.abort();
    plugin_hook_worker.abort();
    plugin_market_refresh_worker.abort();
    connector_supervisor.abort();
    core_sync_worker.abort();
    catalog_worker.abort();
    result
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

async fn resolve_capability_token(
    configured: Option<String>,
    token_file: &PathBuf,
) -> Result<String> {
    if let Some(token) = configured
        .map(|token| token.trim().to_owned())
        .filter(|token| token.len() >= 32)
    {
        persist_capability_token(token_file, &token).await?;
        return Ok(token);
    }
    if let Ok(token) = fs::read_to_string(token_file).await {
        let token = token.trim().to_owned();
        if token.len() >= 32 {
            restrict_capability_token_permissions(token_file).await?;
            return Ok(token);
        }
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    persist_capability_token(token_file, &token).await?;
    Ok(token)
}

async fn persist_capability_token(token_file: &PathBuf, token: &str) -> Result<()> {
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
    restrict_capability_token_permissions(token_file).await
}

async fn restrict_capability_token_permissions(token_file: &PathBuf) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(token_file, std::fs::Permissions::from_mode(0o600))
            .await
            .with_context(|| {
                format!(
                    "failed to restrict capability token permissions on {}",
                    token_file.display()
                )
            })?;
    }
    Ok(())
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
mod tests;
