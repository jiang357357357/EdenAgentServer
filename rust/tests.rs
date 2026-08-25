use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

#[test]
fn local_stt_pcm_is_wrapped_as_mono_16khz_wav() {
    let audio = [1_u8, 2, 3, 4];
    let wav = pcm16_wav(&audio).expect("wav");
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(
        u32::from_le_bytes(wav[24..28].try_into().expect("sample rate")),
        16_000
    );
    assert_eq!(
        u16::from_le_bytes(wav[34..36].try_into().expect("bit depth")),
        16
    );
    assert_eq!(&wav[44..], &audio);
}

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
    initialize_voice_config(&store).await.expect("voice config");
    let core_sync = CoreSyncService::new(store.clone()).expect("Core sync");
    let runtime = SessionRuntime::new(
        store.clone(),
        model_spec_from_env(),
        Arc::new(UnavailableProvider::new("test provider is unavailable")),
        ToolRegistry::new(),
        "test",
    );
    let approvals = ApprovalService::new(store.clone(), PermissionPolicy::new(PolicyEffect::Ask));
    let questions = QuestionService::new(store.clone());
    let blob_directory = tempfile::tempdir().expect("blob tempdir").keep();
    let blobs = BlobService::new(blob_directory, store.clone(), 32 * 1024 * 1024)
        .await
        .expect("blobs");
    let media = MediaService::new(store.clone(), blobs.clone());
    let plugin_directory = tempfile::tempdir().expect("plugin tempdir").keep();
    let plugins = PluginInstaller::open(plugin_directory).expect("plugins");
    let marketplace =
        MarketplaceClient::new(plugins.store().root().join("market-cache")).expect("marketplace");
    let skill_directory = tempfile::tempdir().expect("skill tempdir").keep();
    let skills = SkillCatalog::discover(&[], skill_directory).expect("skills");
    let workspace_directory = tempfile::tempdir().expect("workspace tempdir").keep();
    let workspaces = WorkspaceService::initialize(
        store.clone(),
        workspace_directory.clone(),
        ProcessSandbox::Disabled,
    )
    .await
    .expect("workspaces");
    let connectors = ConnectorService::new(store.clone()).expect("connectors");
    let mcp = McpManager::new(ProcessSandbox::Disabled, workspace_directory.clone());
    let plugin_hooks = PluginHookCatalog::default();
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
        runtime_origin: RuntimeOrigin::Mon,
        capability_token: Arc::from("0123456789abcdef0123456789abcdef"),
        allowed_origins: Arc::new(HashSet::from(["http://localhost:40091".to_owned()])),
        store,
        runtime,
        approvals,
        questions,
        media,
        blobs,
        plugins,
        skills,
        connectors,
        mcp,
        marketplace,
        plugin_hooks,
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
    assert_eq!(value["agentCoreVersion"], eden_agent_core::VERSION);
    assert_eq!(value["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(value["runtimeOrigin"], "mon");
}

#[tokio::test]
async fn voice_configuration_is_persisted_in_server_sqlite_and_reads_back_immediately() {
    let state = test_state().await;
    let current = execute_method(&state, "voice.config.read", json!({}))
        .await
        .expect("read voice config");
    assert_eq!(current["tts"]["provider"], "gsv");
    assert_eq!(current["stt"]["provider"], "gsv");

    let mut tts = current["tts"].clone();
    tts["roleId"] = json!("arona-1");
    tts["emotion"] = json!("开心");
    let updated = execute_method(&state, "voice.tts.config.update", tts)
        .await
        .expect("update TTS config");
    assert_eq!(updated["tts"]["emotion"], "开心");
    let persisted = state
        .store
        .get_config(GSV_TTS_CONFIG_KEY)
        .await
        .expect("persisted TTS config")
        .expect("TTS config row");
    assert_eq!(persisted["roleId"], "arona-1");

    let mut stt = current["stt"].clone();
    stt["language"] = json!("auto");
    let updated = execute_method(&state, "voice.stt.config.update", stt)
        .await
        .expect("update STT config");
    assert_eq!(updated["stt"]["language"], "auto");
    assert_eq!(
        state
            .store
            .get_config(GSV_STT_CONFIG_KEY)
            .await
            .expect("persisted STT config")
            .expect("STT config row")["language"],
        "auto"
    );
}

#[tokio::test]
async fn voice_gsv_rpc_discovers_tests_and_previews_through_the_server() {
    let app = Router::new()
        .route(
            "/api/models/versions/from-enum/",
            get(|| async { Json(json!({"versions":["v2ProPlus"]})) }),
        )
        .route(
            "/api/world/list/",
            get(|| async { Json(json!({"worlds":[{"name":"BlueArchive"}]})) }),
        )
        .route(
            "/api/role/list/",
            get(|| async { Json(json!({"roles":[{"id":"arona-1","name":"阿罗娜"}]})) }),
        )
        .route(
            "/api/role/emotions/",
            get(|| async { Json(json!({"emotions":["平常","开心"]})) }),
        )
        .route(
            "/api/synthesis/role-emotion",
            post(|Json(payload): Json<Value>| async move {
                assert_eq!(payload["role_id"], "arona-1");
                assert_eq!(payload["text"], "老师，您好");
                Json(json!({
                    "success":true,
                    "audio_data":BASE64.encode(b"test-wav"),
                    "duration":1.25
                }))
            }),
        )
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock GSV listener");
    let address = listener.local_addr().expect("mock GSV address");
    let mock = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock GSV server");
    });

    let state = test_state().await;
    let mut tts = default_gsv_tts_config();
    tts.service_url = format!("http://{address}");
    tts.version = "v2ProPlus".to_owned();
    tts.world = "BlueArchive".to_owned();
    tts.role = "阿罗娜".to_owned();
    tts.role_id = "arona-1".to_owned();
    tts.emotion = "平常".to_owned();

    let discovery = execute_method(
        &state,
        "voice.gsv.discover",
        json!({"config":&tts,"stage":"all"}),
    )
    .await
    .expect("discover GSV catalog");
    assert_eq!(discovery["selectedRoleId"], "arona-1");
    assert_eq!(discovery["emotions"][1]["value"], "开心");

    let preview = execute_method(
        &state,
        "voice.gsv.preview",
        json!({"config":&tts,"text":"老师，您好"}),
    )
    .await
    .expect("preview GSV voice");
    assert_eq!(preview["mime"], "audio/wav");
    assert_eq!(preview["durationMs"], 1250);
    assert!(
        preview["audioBlobId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );

    let mut stt = default_gsv_stt_config();
    stt.service_url = format!("http://{address}");
    let tested = execute_method(&state, "voice.stt.test", json!({"config":stt}))
        .await
        .expect("test GSV STT");
    assert_eq!(tested["ok"], true);
    mock.abort();
}

#[test]
fn voice_configuration_rejects_unsafe_urls_and_out_of_range_values() {
    let mut tts = default_gsv_tts_config();
    tts.service_url = "file:///tmp/gsv".to_owned();
    assert!(normalize_gsv_tts_config(tts).is_err());

    let mut stt = default_gsv_stt_config();
    stt.speech_noise_threshold = f64::NAN;
    assert!(normalize_gsv_stt_config(stt).is_err());
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
    assert!(body.contains("eden_agent_active_sessions"));
    assert!(body.contains("eden_agent_first_token_seconds_sum"));
    assert!(body.contains("eden_agent_provider_retries_total"));
    assert!(body.contains("eden_agent_database_scrape_latency_seconds"));
    assert!(body.contains("eden_agent_legacy_skill_reinstalls_pending"));
    assert!(body.contains("eden_agent_legacy_permission_reauthorization_required"));
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
async fn configured_capability_token_is_synchronized_to_the_desktop_token_file() {
    let directory = tempfile::tempdir().expect("token directory");
    let token_file = directory.path().join("server-capability.token");
    fs::write(&token_file, "stale-token-that-must-not-be-used-0000\n")
        .await
        .expect("stale token");
    let configured = "configured-token-0123456789abcdef0123456789abcdef".to_owned();
    let resolved = resolve_capability_token(Some(configured.clone()), &token_file)
        .await
        .expect("resolve token");
    assert_eq!(resolved, configured);
    assert_eq!(
        fs::read_to_string(&token_file)
            .await
            .expect("synchronized token")
            .trim(),
        configured
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&token_file)
                .expect("token metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
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
        format!("{WEBSOCKET_PROTOCOL}, eden-agent-token.0123456789abcdef0123456789abcdef")
            .parse()
            .expect("header"),
    );
    assert!(token_matches(&test_state().await, &headers));
}

#[test]
fn command_line_configuration_parses_typed_long_term_server_settings() {
    let args = Args::try_parse_from([
        "eden-agent-server",
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
        "http://127.0.0.1:40091,edenagent://app",
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
            "edenagent://app".to_owned()
        ]
    );
    assert!(Args::try_parse_from(["eden-agent-server", "--log-max-files", "many"]).is_err());
    assert!(Args::try_parse_from(["eden-agent-server", "--bind", "0.0.0.0:not-a-port"]).is_err());
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
async fn plugin_rpc_installs_immutable_versions_and_rolls_back() {
    let state = test_state().await;
    let source = tempfile::tempdir().expect("plugin source");
    std::fs::create_dir_all(source.path().join("skills/workflow")).expect("skill directory");
    std::fs::write(
        source.path().join("skills/workflow/SKILL.md"),
        "---\nname: workflow\ndescription: test\n---\n",
    )
    .expect("skill");
    std::fs::create_dir_all(source.path().join("connector")).expect("connector directory");
    std::fs::write(source.path().join("connector/worker"), b"worker").expect("worker");
    std::fs::write(
        source.path().join("connector/connector.json"),
        serde_json::to_vec(&json!({
            "schemaVersion":1,
            "id":"rpc-worker",
            "name":"RPC Worker",
            "description":"plugin connector",
            "version":"1.0.0",
            "protocolVersion":1,
            "icon":"cable",
            "entrypoints":{
                eden_agent_connector_package::current_platform():{
                    "path":"worker","args":[]
                }
            },
            "settingsSchema":{"type":"object","properties":{},"additionalProperties":false},
            "events":{},"queries":{},"actions":{}
        }))
        .expect("connector manifest"),
    )
    .expect("connector manifest");
    let write_manifest = |version: &str| {
        std::fs::write(
            source.path().join("plugin.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "id": "mon.rpc-test",
                "name": "RPC Test",
                "description": "plugin RPC test",
                "version": version,
                "components": {
                    "skills": [{
                        "id": "workflow",
                        "path": "skills/workflow/SKILL.md"
                    }],
                    "runtimes": [{
                        "id": "worker",
                        "kind": "native_worker",
                        "manifest": "connector/connector.json"
                    }]
                }
            }))
            .expect("serialize manifest"),
        )
        .expect("manifest");
    };

    write_manifest("1.0.0");
    let preview = execute_method(
        &state,
        "plugin.inspect",
        json!({
            "sourceType": "local",
            "sourceUri": source.path().to_string_lossy()
        }),
    )
    .await
    .expect("inspect");
    let first = execute_method(
        &state,
        "plugin.install_preview",
        json!({"previewID":preview["previewID"]}),
    )
    .await
    .expect("install first");
    let first_revision = first["revision"]
        .as_str()
        .expect("first revision")
        .to_owned();
    assert_eq!(first["version"], "1.0.0");
    assert_eq!(first["versions"].as_array().expect("versions").len(), 1);
    assert_eq!(
        state
            .skills
            .get("workflow")
            .expect("plugin skill")
            .source_type,
        "plugin"
    );
    let connector_catalog = execute_method(&state, "connector.catalog", json!({}))
        .await
        .expect("connector catalog");
    assert!(
        connector_catalog["connectors"]
            .as_array()
            .expect("connectors")
            .iter()
            .any(|connector| connector["key"] == "rpc-worker")
    );

    write_manifest("1.1.0");
    let preview = execute_method(
        &state,
        "plugin.inspect",
        json!({
            "sourceType": "local",
            "sourceUri": source.path().to_string_lossy()
        }),
    )
    .await
    .expect("inspect update");
    let updated = execute_method(
        &state,
        "plugin.install_preview",
        json!({"previewID":preview["previewID"]}),
    )
    .await
    .expect("install update");
    assert_eq!(updated["version"], "1.1.0");
    assert_eq!(updated["versions"].as_array().expect("versions").len(), 2);

    let rolled_back = execute_method(
        &state,
        "plugin.activate",
        json!({
            "id":"mon.rpc-test",
            "version":"1.0.0",
            "revision":first_revision
        }),
    )
    .await
    .expect("rollback");
    assert_eq!(rolled_back["version"], "1.0.0");
    apply_plugin_market_revocations(
        &state,
        &[MarketRevocation {
            plugin_id: "mon.rpc-test".to_owned(),
            version: "1.0.0".to_owned(),
            revision: first_revision.clone(),
            reason: "test revocation".to_owned(),
        }],
    )
    .await
    .expect("apply market revocation");
    let revoked = execute_method(&state, "plugin.read", json!({"id":"mon.rpc-test"}))
        .await
        .expect("revoked plugin");
    assert_eq!(revoked["enabled"], false);
    assert!(state.skills.get("workflow").is_none());
    let disabled = execute_method(
        &state,
        "plugin.enable",
        json!({"id":"mon.rpc-test","enabled":false}),
    )
    .await
    .expect("disable");
    assert_eq!(disabled["enabled"], false);
    assert!(state.skills.get("workflow").is_none());
    let connector_catalog = execute_method(&state, "connector.catalog", json!({}))
        .await
        .expect("connector catalog");
    assert!(
        !connector_catalog["connectors"]
            .as_array()
            .expect("connectors")
            .iter()
            .any(|connector| connector["key"] == "rpc-worker")
    );
    let uninstalled = execute_method(&state, "plugin.uninstall", json!({"id":"mon.rpc-test"}))
        .await
        .expect("uninstall");
    assert_eq!(uninstalled["removedVersions"], 2);
    assert_eq!(uninstalled["cleanupErrors"], json!([]));
    assert!(
        state
            .plugins
            .store()
            .installed()
            .expect("installed")
            .is_empty()
    );
    assert_eq!(
        execute_method(&state, "plugin.list", json!({}))
            .await
            .expect("plugins"),
        json!([])
    );
}

#[tokio::test]
async fn plugin_permissions_are_explicit_and_revision_scoped() {
    let state = test_state().await;
    let source = tempfile::tempdir().expect("plugin source");
    std::fs::create_dir_all(source.path().join("skills/reviewed")).expect("skill directory");
    std::fs::write(
        source.path().join("skills/reviewed/SKILL.md"),
        "---\nname: reviewed\ndescription: permission review test\n---\n",
    )
    .expect("skill");
    let write_manifest = |version: &str| {
        std::fs::write(
            source.path().join("plugin.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "id": "mon.permission-test",
                "name": "Permission Test",
                "description": "permission review test",
                "version": version,
                "components": {
                    "skills": [{
                        "id": "reviewed",
                        "path": "skills/reviewed/SKILL.md"
                    }]
                },
                "permissions": [{
                    "capability": "filesystem.read",
                    "resource": "workspace",
                    "access": "read",
                    "required": true,
                    "description": "Read the selected workspace"
                }]
            }))
            .expect("manifest JSON"),
        )
        .expect("manifest");
    };
    write_manifest("1.0.0");
    let preview = execute_method(
        &state,
        "plugin.inspect",
        json!({
            "sourceType": "local",
            "sourceUri": source.path().to_string_lossy()
        }),
    )
    .await
    .expect("inspect");
    let install_error = execute_method(
        &state,
        "plugin.install_preview",
        json!({"previewID":preview["previewID"]}),
    )
    .await
    .expect_err("required permission must block activation");
    assert!(install_error.message.contains("pending permission review"));
    let installed = execute_method(&state, "plugin.read", json!({"id":"mon.permission-test"}))
        .await
        .expect("installed plugin");
    let first_revision = installed["revision"].as_str().expect("revision").to_owned();
    assert_eq!(installed["enabled"], false);
    assert_eq!(installed["permissionGrants"], json!([]));

    let denied = execute_method(
        &state,
        "plugin.permissions.set",
        json!({
            "id":"mon.permission-test",
            "revision":first_revision,
            "decisions":[{
                "capability":"filesystem.read",
                "resource":"workspace",
                "access":"read",
                "decision":"denied"
            }]
        }),
    )
    .await
    .expect("deny permission");
    assert_eq!(denied["permissionGrants"][0]["decision"], "denied");
    execute_method(
        &state,
        "plugin.enable",
        json!({"id":"mon.permission-test","enabled":true}),
    )
    .await
    .expect_err("denied required permission must keep plugin disabled");

    execute_method(
        &state,
        "plugin.permissions.set",
        json!({
            "id":"mon.permission-test",
            "revision":first_revision,
            "decisions":[{
                "capability":"filesystem.read",
                "resource":"workspace",
                "access":"read",
                "decision":"allowed"
            }]
        }),
    )
    .await
    .expect("allow permission");
    let enabled = execute_method(
        &state,
        "plugin.enable",
        json!({"id":"mon.permission-test","enabled":true}),
    )
    .await
    .expect("enable reviewed plugin");
    assert_eq!(enabled["enabled"], true);
    assert!(state.skills.get("reviewed").is_some());

    write_manifest("2.0.0");
    let preview = execute_method(
        &state,
        "plugin.inspect",
        json!({
            "sourceType": "local",
            "sourceUri": source.path().to_string_lossy()
        }),
    )
    .await
    .expect("inspect update");
    let updated = execute_method(
        &state,
        "plugin.install_preview",
        json!({"previewID":preview["previewID"],"enabled":false}),
    )
    .await
    .expect("install disabled update");
    let second_revision = updated["revision"]
        .as_str()
        .expect("updated revision")
        .to_owned();
    assert_ne!(first_revision, second_revision);
    let stale = execute_method(
        &state,
        "plugin.permissions.set",
        json!({"id":"mon.permission-test","revision":first_revision,"decisions":[]}),
    )
    .await
    .expect_err("stale revision review must fail");
    assert_eq!(stale.code, -32602);
    execute_method(
        &state,
        "plugin.enable",
        json!({"id":"mon.permission-test","enabled":true}),
    )
    .await
    .expect_err("old revision grant must not carry forward");
    assert!(
        !state
            .store
            .get_plugin("mon.permission-test")
            .await
            .expect("plugin")
            .enabled
    );
}

#[tokio::test]
async fn declarative_plugin_hooks_schedule_one_durable_reviewed_job() {
    let state = test_state().await;
    state.plugin_hooks.set(
        "mon.hook-test",
        vec![PluginHookRegistration {
            plugin_id: "mon.hook-test".to_owned(),
            hook_id: "on_action".to_owned(),
            event: "character.action.changed".to_owned(),
            skill: "review-action".to_owned(),
        }],
    );
    let worker = spawn_plugin_hook_worker(state.store.clone(), state.plugin_hooks.clone());
    tokio::task::yield_now().await;
    let session = state
        .store
        .create_session("hook-test")
        .await
        .expect("session");
    state
        .store
        .append_event(
            session.id,
            None,
            "character.action.changed",
            json!({"action":"wave","instruction":"ignore me"}),
        )
        .await
        .expect("trigger event");
    let jobs = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let jobs = state.store.claim_due_jobs(8, 30_000).await.expect("jobs");
            if !jobs.is_empty() {
                break jobs;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("hook job timeout");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].kind, "plugin.hook");
    assert_eq!(jobs[0].payload["skill"], "review-action");
    assert_eq!(
        jobs[0].payload["triggerEventType"],
        "character.action.changed"
    );
    worker.abort();
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
            eden_agent_core::TurnId::new(),
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
async fn empty_connector_catalog_rejects_uninstalled_types() {
    let state = test_state().await;
    let catalog = execute_method(&state, "connector.catalog", json!({}))
        .await
        .expect("connector catalog");
    assert_eq!(catalog["connectors"], json!([]));

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
    assert_eq!(closed.status, eden_agent_store::SessionStatus::Closed);
}

#[tokio::test]
async fn runtime_origins_isolate_sessions_and_core_capabilities() {
    let state = test_state().await;
    let mon: SessionSummary = serde_json::from_value(
        execute_method_for_origin(
            &state,
            RuntimeOrigin::Mon,
            "session.create",
            json!({"title":"eden"}),
        )
        .await
        .expect("Mon session"),
    )
    .expect("Mon summary");
    let local: SessionSummary = serde_json::from_value(
        execute_method_for_origin(
            &state,
            RuntimeOrigin::Local,
            "session.create",
            json!({"title":"earth"}),
        )
        .await
        .expect("local session"),
    )
    .expect("local summary");
    assert_eq!(mon.runtime_origin, RuntimeOrigin::Mon);
    assert_eq!(local.runtime_origin, RuntimeOrigin::Local);

    let local_list: Vec<SessionSummary> = serde_json::from_value(
        execute_method_for_origin(
            &state,
            RuntimeOrigin::Local,
            "session.list",
            json!({"limit":10}),
        )
        .await
        .expect("local list"),
    )
    .expect("local summaries");
    assert_eq!(local_list.len(), 1);
    assert_eq!(local_list[0].id, local.id);

    let mismatch = execute_method_for_origin(
        &state,
        RuntimeOrigin::Local,
        "session.read",
        json!({"sessionId":mon.id}),
    )
    .await
    .expect_err("local connection must not read a Mon session");
    assert!(mismatch.message.contains("runtime_origin_mismatch"));

    let core_only =
        execute_method_for_origin(&state, RuntimeOrigin::Local, "model.catalog", json!({}))
            .await
            .expect_err("local connection must not use the Core model catalog");
    assert!(core_only.message.contains("requires the Mon runtime"));
    assert!(runtime_capabilities(RuntimeOrigin::Local).contains(&"local-model".to_owned()));
    assert!(runtime_capabilities(RuntimeOrigin::Local).contains(&"voice-tts".to_owned()));
    assert!(runtime_capabilities(RuntimeOrigin::Local).contains(&"voice-stt-realtime".to_owned()));
}
