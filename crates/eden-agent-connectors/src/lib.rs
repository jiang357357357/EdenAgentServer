//! Durable connector lifecycle and connector-facing agent tools.

mod manifest;
pub mod openttd;

pub use manifest::ManifestCatalog;

use async_trait::async_trait;
use eden_agent_connector_host::{WorkerClient, WorkerLaunchConfig, WorkerProcess};
use eden_agent_connector_package::{LoadPolicy, LoadedPackage, PackageCatalog};
use eden_agent_connector_protocol::{
    GrantedPermission, PublishedEvent, RpcNotification, WorkerStatus, method,
};
use eden_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use eden_agent_store::{ConnectorRecord, Store};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{Mutex, RwLock},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct ConnectorService {
    inner: Arc<Inner>,
}

#[derive(Clone, Debug)]
pub struct ConnectorServiceConfig {
    pub manifest_root: PathBuf,
    pub package_root: PathBuf,
    pub package_policy: LoadPolicy,
    pub connector_data_root: PathBuf,
}

impl Default for ConnectorServiceConfig {
    fn default() -> Self {
        let package_policy = if cfg!(debug_assertions)
            || std::env::var_os("EDEN_AGENT_ALLOW_UNTRUSTED_CONNECTORS").as_deref()
                == Some(std::ffi::OsStr::new("1"))
        {
            LoadPolicy::Development
        } else {
            LoadPolicy::Production
        };
        Self {
            manifest_root: std::env::var_os("EDEN_AGENT_CONNECTOR_MANIFEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../connectors/manifests")
                }),
            package_root: std::env::var_os("EDEN_AGENT_CONNECTOR_PACKAGE_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("Data/connectors/packages")),
            package_policy,
            connector_data_root: std::env::var_os("EDEN_AGENT_CONNECTOR_DATA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("Data/connectors/runtime")),
        }
    }
}
struct Inner {
    store: Store,
    reconcile_lock: Mutex<()>,
    active: Mutex<HashMap<Uuid, ActiveConnector>>,
    manifests: ManifestCatalog,
    plugin_permission_grants:
        RwLock<BTreeMap<String, BTreeMap<String, Vec<ConnectorPermissionGrant>>>>,
    connector_data_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorPermissionGrant {
    pub capability: String,
    pub resource: String,
    pub access: String,
}

#[derive(Clone, Debug)]
pub struct PluginConnectorPackage {
    pub package: LoadedPackage,
    pub granted_permissions: Vec<ConnectorPermissionGrant>,
}
struct ActiveConnector {
    generation: Uuid,
    cancellation: CancellationToken,
    configuration: Value,
    worker: Arc<RwLock<Option<WorkerClient>>>,
    _task: JoinHandle<()>,
}

impl ConnectorService {
    pub fn new(store: Store) -> Result<Self, String> {
        Self::with_config(store, ConnectorServiceConfig::default())
    }

    pub fn with_config(store: Store, config: ConnectorServiceConfig) -> Result<Self, String> {
        let packages = PackageCatalog::load(config.package_root, config.package_policy)
            .map_err(|error| error.to_string())?;
        let manifests =
            ManifestCatalog::load_with_packages(config.manifest_root, packages.clone())?;
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                reconcile_lock: Mutex::new(()),
                active: Mutex::new(HashMap::new()),
                manifests,
                plugin_permission_grants: RwLock::new(BTreeMap::new()),
                connector_data_root: config.connector_data_root,
            }),
        })
    }

    #[must_use]
    pub fn catalog_json(&self) -> Value {
        self.inner.manifests.catalog_json()
    }

    pub fn validate_registration(&self, key: &str, settings: &Value) -> Result<(), String> {
        self.inner.manifests.validate_settings(key, settings)
    }

    pub fn validate_query(&self, key: &str, query: &str, payload: &Value) -> Result<(), String> {
        self.inner.manifests.validate_query(key, query, payload)
    }

    pub async fn set_plugin_packages(
        &self,
        plugin_id: &str,
        packages: Vec<PluginConnectorPackage>,
    ) -> Result<bool, String> {
        let grants = packages
            .iter()
            .map(|entry| {
                (
                    entry.package.manifest.id.clone(),
                    entry.granted_permissions.clone(),
                )
            })
            .collect();
        let loaded = packages.into_iter().map(|entry| entry.package).collect();
        let changed = self
            .inner
            .manifests
            .set_plugin_packages(plugin_id, loaded)?;
        self.inner
            .plugin_permission_grants
            .write()
            .await
            .insert(plugin_id.to_owned(), grants);
        if changed {
            self.invalidate_active().await;
        }
        Ok(changed)
    }

    pub async fn remove_plugin_packages(&self, plugin_id: &str) -> Result<bool, String> {
        let changed = self.inner.manifests.remove_plugin_packages(plugin_id)?;
        self.inner
            .plugin_permission_grants
            .write()
            .await
            .remove(plugin_id);
        if changed {
            self.invalidate_active().await;
        }
        Ok(changed)
    }

    async fn invalidate_active(&self) {
        let active = self
            .inner
            .active
            .lock()
            .await
            .drain()
            .map(|(_, connector)| connector)
            .collect::<Vec<_>>();
        for connector in active {
            connector.cancellation.cancel();
        }
    }

    pub fn start(&self) -> JoinHandle<()> {
        self.start_inner(None)
    }

    pub async fn shutdown(&self) {
        let active = self
            .inner
            .active
            .lock()
            .await
            .drain()
            .map(|(_, connector)| connector)
            .collect::<Vec<_>>();
        for connector in &active {
            connector.cancellation.cancel();
        }
        for mut connector in active {
            let _ = tokio::time::timeout(Duration::from_secs(6), &mut connector._task).await;
        }
    }

    #[must_use]
    pub fn start_with_heartbeat(&self, heartbeat: Arc<AtomicI64>) -> JoinHandle<()> {
        self.start_inner(Some(heartbeat))
    }

    fn start_inner(&self, heartbeat: Option<Arc<AtomicI64>>) -> JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Some(heartbeat) = heartbeat.as_ref() {
                    heartbeat.store(epoch_millis(), Ordering::Relaxed);
                }
                match service.inner.manifests.refresh() {
                    Ok(true) => {
                        let active = service
                            .inner
                            .active
                            .lock()
                            .await
                            .drain()
                            .map(|(_, value)| value)
                            .collect::<Vec<_>>();
                        for connector in active {
                            connector.cancellation.cancel();
                        }
                    }
                    Ok(false) => {}
                    Err(error) => tracing::warn!(%error, "connector manifest refresh rejected"),
                }
                service.reconcile().await;
            }
        })
    }

    async fn reconcile(&self) {
        let _single_flight = self.inner.reconcile_lock.lock().await;
        let connectors = match self.inner.store.list_connectors().await {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "failed to load connector registry during reconciliation");
                return;
            }
        };
        let wanted = connectors
            .iter()
            .filter(|item| item.desired_state == "connected")
            .map(|item| (item.id, connector_configuration(item)))
            .collect::<HashMap<_, _>>();
        let stale = self
            .inner
            .active
            .lock()
            .await
            .iter()
            .filter(|(id, active)| {
                wanted.get(id) != Some(&active.configuration) || active._task.is_finished()
            })
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in stale {
            if let Some(active) = self.inner.active.lock().await.remove(&id) {
                active.cancellation.cancel();
            }
            let _ = self
                .inner
                .store
                .report_connector_state(id, "offline", None)
                .await;
        }
        for connector in connectors
            .into_iter()
            .filter(|item| wanted.contains_key(&item.id))
        {
            if !self.inner.manifests.contains(&connector.connector_key) {
                tracing::warn!(
                    connector_id = %connector.id,
                    connector_key = %connector.connector_key,
                    "connector manifest is missing"
                );
                let _ = self
                    .inner
                    .store
                    .report_connector_state(
                        connector.id,
                        "error",
                        Some("connector manifest is missing"),
                    )
                    .await;
                continue;
            }
            if self.inner.active.lock().await.contains_key(&connector.id) {
                continue;
            }
            let cancellation = CancellationToken::new();
            let generation = Uuid::now_v7();
            let service = self.clone();
            let task_connector = connector.clone();
            let child = cancellation.clone();
            let Some(package) = self.inner.manifests.package(&connector.connector_key) else {
                let _ = self
                    .inner
                    .store
                    .report_connector_state(
                        connector.id,
                        "error",
                        Some("connector package is not installed"),
                    )
                    .await;
                continue;
            };
            let worker = Arc::new(RwLock::new(None));
            let (start, started) = tokio::sync::oneshot::channel();
            let task_worker = worker.clone();
            tracing::info!(
                connector_id = %connector.id,
                connector_key = %connector.connector_key,
                "starting connector worker"
            );
            let task = tokio::spawn(async move {
                let _ = started.await;
                service
                    .run_connector(task_connector, generation, child, package, task_worker)
                    .await;
            });
            self.inner.active.lock().await.insert(
                connector.id,
                ActiveConnector {
                    generation,
                    cancellation,
                    configuration: connector_configuration(&connector),
                    worker,
                    _task: task,
                },
            );
            let _ = start.send(());
        }
    }

    async fn run_connector(
        &self,
        connector: ConnectorRecord,
        generation: Uuid,
        cancellation: CancellationToken,
        package: LoadedPackage,
        worker: Arc<RwLock<Option<WorkerClient>>>,
    ) {
        let _ = self
            .inner
            .store
            .report_connector_state(connector.id, "connecting", None)
            .await;
        let result = self
            .run_package_worker(&connector, cancellation.clone(), package, worker)
            .await;
        let error = result.err();
        if cancellation.is_cancelled() {
            tracing::info!(
                connector_id = %connector.id,
                connector_key = %connector.connector_key,
                "connector worker stopped"
            );
            let _ = self
                .inner
                .store
                .report_connector_state(connector.id, "offline", None)
                .await;
        } else {
            tracing::warn!(
                connector_id = %connector.id,
                connector_key = %connector.connector_key,
                error = error.as_deref().unwrap_or("connector worker exited unexpectedly"),
                "connector worker failed"
            );
            let _ = self
                .inner
                .store
                .report_connector_state(connector.id, "error", error.as_deref())
                .await;
        }
        let mut active = self.inner.active.lock().await;
        if active
            .get(&connector.id)
            .is_some_and(|worker| worker.generation == generation)
        {
            active.remove(&connector.id);
        }
    }

    async fn run_package_worker(
        &self,
        connector: &ConnectorRecord,
        cancellation: CancellationToken,
        package: LoadedPackage,
        worker_slot: Arc<RwLock<Option<WorkerClient>>>,
    ) -> Result<(), String> {
        let mut launch = WorkerLaunchConfig::new(
            package.clone(),
            connector.id.to_string(),
            connector.settings.clone(),
            self.inner
                .connector_data_root
                .join(connector.id.to_string()),
        );
        launch.environment.insert(
            "MON_CONNECTOR_IDENTITY_KEY".to_owned(),
            connector.identity_key.clone(),
        );
        let allowed =
            if let Some(plugin_id) = self.inner.manifests.plugin_owner(&package.manifest.id) {
                self.inner
                    .plugin_permission_grants
                    .read()
                    .await
                    .get(&plugin_id)
                    .and_then(|packages| packages.get(&package.manifest.id))
                    .cloned()
                    .or_else(|| Some(Vec::new()))
            } else {
                None
            };
        launch.granted_permissions =
            resolve_package_permissions(&package, &connector.settings, allowed.as_deref());
        for permission in &launch.granted_permissions {
            if permission.capability != "environment.read" {
                continue;
            }
            let (source_name, target_name) =
                if permission.resource == "connector.identityCredential" {
                    (
                        connector_credential_environment(
                            &connector.connector_key,
                            &connector.identity_key,
                        )?,
                        "MON_CONNECTOR_IDENTITY_CREDENTIAL".to_owned(),
                    )
                } else {
                    (permission.resource.clone(), permission.resource.clone())
                };
            if !valid_environment_name(&source_name) || !valid_environment_name(&target_name) {
                return Err(format!(
                    "connector package requested invalid environment name: {source_name}"
                ));
            }
            if let Ok(value) = std::env::var(&source_name) {
                launch.environment.insert(target_name, value);
            }
        }
        for key in ["USERPROFILE", "OneDrive", "HOME", "XDG_DOCUMENTS_DIR"] {
            if let Ok(value) = std::env::var(key) {
                launch.environment.insert(key.to_owned(), value);
            }
        }
        let mut process = WorkerProcess::launch(launch)
            .await
            .map_err(|error| error.to_string())?;
        *worker_slot.write().await = Some(process.client());
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    *worker_slot.write().await = None;
                    return process.shutdown().await.map_err(|error| error.to_string());
                }
                notification = process.recv_notification() => {
                    let Some(notification) = notification else {
                        *worker_slot.write().await = None;
                        return Err("connector worker protocol stream closed".to_owned());
                    };
                    self.handle_worker_notification(connector, &package, notification).await?;
                }
            }
        }
    }

    async fn handle_worker_notification(
        &self,
        connector: &ConnectorRecord,
        package: &LoadedPackage,
        notification: RpcNotification,
    ) -> Result<(), String> {
        match notification.method.as_str() {
            method::EVENT_PUBLISH => {
                let event: PublishedEvent = serde_json::from_value(notification.params)
                    .map_err(|error| format!("invalid worker event: {error}"))?;
                if !package.manifest.events.contains_key(&event.event_type) {
                    return Err(format!(
                        "worker published undeclared event {}",
                        event.event_type
                    ));
                }
                if event.event_type == "bridge_ready" {
                    self.inner
                        .store
                        .report_connector_state(connector.id, "connected", None)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                self.inner
                    .store
                    .publish_connector_event(
                        connector.id,
                        &event.external_id,
                        &format!("{}.{}", connector.connector_key, event.event_type),
                        event.payload,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
            }
            method::STATUS => {
                let status: WorkerStatus = serde_json::from_value(notification.params)
                    .map_err(|error| format!("invalid worker status: {error}"))?;
                let runtime_state = match status.state.as_str() {
                    "ready" => "connected",
                    "starting" | "connecting" => "connecting",
                    "degraded" => "error",
                    other => return Err(format!("worker reported invalid status {other}")),
                };
                self.inner
                    .store
                    .report_connector_state(connector.id, runtime_state, status.detail.as_deref())
                    .await
                    .map_err(|error| error.to_string())?;
            }
            method::LOG => {
                tracing::info!(
                    connector_id = %connector.id,
                    connector_key = %connector.connector_key,
                    worker_log = %notification.params,
                    "connector worker diagnostic"
                );
            }
            other => return Err(format!("worker sent unsupported notification {other}")),
        }
        Ok(())
    }

    pub async fn execute(
        &self,
        connector: &ConnectorRecord,
        action: &str,
        payload: Value,
    ) -> Result<Value, String> {
        let mut schema_payload = payload.clone();
        if let Some(object) = schema_payload.as_object_mut() {
            object.remove("operationId");
        }
        self.inner
            .manifests
            .validate_action(&connector.connector_key, action, &schema_payload)?;
        let operation_id = payload
            .get("operationId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.active_worker(connector.id)
            .await?
            .execute(action, schema_payload, operation_id)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn query(
        &self,
        connector: &ConnectorRecord,
        query: &str,
        payload: Value,
    ) -> Result<Value, String> {
        self.inner
            .manifests
            .validate_query(&connector.connector_key, query, &payload)?;
        self.active_worker(connector.id)
            .await?
            .query(query, payload)
            .await
            .map_err(|error| error.to_string())
    }

    async fn active_worker(&self, connector_id: Uuid) -> Result<WorkerClient, String> {
        let slot = self
            .inner
            .active
            .lock()
            .await
            .get(&connector_id)
            .map(|active| active.worker.clone())
            .ok_or("connector package worker is not active")?;
        let client = slot.read().await.clone();
        client.ok_or_else(|| "connector package worker is still starting".to_owned())
    }

    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        [
            ConnectorToolAction::List,
            ConnectorToolAction::Describe,
            ConnectorToolAction::Register,
            ConnectorToolAction::SetState,
            ConnectorToolAction::Claim,
            ConnectorToolAction::Finish,
            ConnectorToolAction::Execute,
            ConnectorToolAction::Query,
            ConnectorToolAction::QueryOpenTtd,
            ConnectorToolAction::QueryVictoria3,
            ConnectorToolAction::OpenTtdNewGrf,
        ]
        .into_iter()
        .map(|action| {
            Arc::new(ConnectorTool {
                service: self.clone(),
                action,
            }) as Arc<dyn Tool>
        })
        .collect()
    }
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn connector_configuration(connector: &ConnectorRecord) -> Value {
    json!({
        "connectorKey":connector.connector_key,
        "identityKey":connector.identity_key,
        "settings":connector.settings,
    })
}

fn resolve_package_permissions(
    package: &LoadedPackage,
    settings: &Value,
    allowed: Option<&[ConnectorPermissionGrant]>,
) -> Vec<GrantedPermission> {
    package
        .manifest
        .permissions
        .iter()
        .filter(|declaration| {
            allowed.is_none_or(|allowed| {
                allowed.iter().any(|grant| {
                    grant.capability == declaration.capability
                        && grant.resource == declaration.resource
                        && grant.access == declaration.access
                })
            })
        })
        .filter_map(|declaration| {
            let resource = declaration
                .resource
                .strip_prefix("settings.")
                .and_then(|path| {
                    path.split('.')
                        .try_fold(settings, |value, segment| value.get(segment))
                })
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    (!declaration.resource.starts_with("settings."))
                        .then(|| declaration.resource.clone())
                })?;
            Some(GrantedPermission {
                capability: declaration.capability.clone(),
                resource,
                access: declaration.access.clone(),
            })
        })
        .collect()
}

fn connector_credential_environment(
    connector_key: &str,
    identity_key: &str,
) -> Result<String, String> {
    let connector = connector_key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut identity = String::new();
    for character in identity_key.chars() {
        if character.is_ascii_alphanumeric() {
            identity.push(character.to_ascii_uppercase());
        } else if !identity.is_empty() && !identity.ends_with('_') {
            identity.push('_');
        }
    }
    while identity.ends_with('_') {
        identity.pop();
    }
    if identity.is_empty() {
        return Err("connector identity key does not contain an ASCII identifier".to_owned());
    }
    Ok(format!("MON_CONNECTOR_{connector}_{identity}"))
}

fn valid_environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[derive(Clone, Copy)]
enum ConnectorToolAction {
    List,
    Describe,
    Register,
    SetState,
    Claim,
    Finish,
    Execute,
    Query,
    QueryOpenTtd,
    QueryVictoria3,
    OpenTtdNewGrf,
}
struct ConnectorTool {
    service: ConnectorService,
    action: ConnectorToolAction,
}
#[async_trait]
impl Tool for ConnectorTool {
    fn definition(&self) -> ToolDefinition {
        let (name, description) = match self.action {
            ConnectorToolAction::List => ("list_connectors", "List durable external connectors"),
            ConnectorToolAction::Describe => (
                "describe_connector",
                "Describe an installed connector package and its declared capabilities",
            ),
            ConnectorToolAction::Register => {
                ("register_connector", "Register an external connector")
            }
            ConnectorToolAction::SetState => (
                "set_connector_state",
                "Connect or disconnect an external connector",
            ),
            ConnectorToolAction::Claim => (
                "claim_connector_events",
                "Claim pending connector events with a lease",
            ),
            ConnectorToolAction::Finish => (
                "finish_connector_events",
                "Complete or release claimed connector events",
            ),
            ConnectorToolAction::Execute => {
                ("execute_connector_action", "Execute a connector action")
            }
            ConnectorToolAction::Query => (
                "query_connector",
                "Run a read-only query declared by a connector package",
            ),
            ConnectorToolAction::QueryOpenTtd => (
                "query_openttd",
                "Read OpenTTD game state through the configured bridge",
            ),
            ConnectorToolAction::QueryVictoria3 => (
                "query_victoria3",
                "Read the latest Victoria 3 observation snapshot",
            ),
            ConnectorToolAction::OpenTtdNewGrf => (
                "openttd_newgrf",
                "List or install local OpenTTD NewGRF files",
            ),
        };
        let mut value = ToolDefinition::direct(name, description);
        value.parameters = match self.action {
            ConnectorToolAction::List => strict_parameters(json!({}), json!([])),
            ConnectorToolAction::Describe => strict_parameters(
                json!({"connectorKey":{"type":"string","minLength":1,"maxLength":128}}),
                json!(["connectorKey"]),
            ),
            ConnectorToolAction::Register => {
                self.service.inner.manifests.registration_tool_schema()
            }
            ConnectorToolAction::SetState => strict_parameters(
                json!({
                    "connectorId":uuid_schema(),
                    "desiredState":{"type":"string","enum":["connected","disconnected"]}
                }),
                json!(["connectorId", "desiredState"]),
            ),
            ConnectorToolAction::Claim => strict_parameters(
                json!({
                    "connectorId":uuid_schema(),
                    "limit":{"type":"integer","minimum":1,"maximum":100}
                }),
                json!(["connectorId"]),
            ),
            ConnectorToolAction::Finish => strict_parameters(
                json!({
                    "eventIds":{"type":"array","minItems":1,"maxItems":100,"items":uuid_schema()},
                    "retry":{"type":"boolean"}
                }),
                json!(["eventIds"]),
            ),
            ConnectorToolAction::Execute => self.service.inner.manifests.action_tool_schema(),
            ConnectorToolAction::Query => self.service.inner.manifests.query_tool_schema(),
            ConnectorToolAction::QueryOpenTtd => strict_parameters(
                json!({
                    "connectorId":uuid_schema(),
                    "query":{"type":"string","enum":["get_state","inspect_tile","find_towns","find_industries","get_company_assets","list_road_engines","find_road_route_site"]},
                    "x":{"type":"integer"},
                    "y":{"type":"integer"},
                    "limit":{"type":"integer","minimum":1,"maximum":100},
                    "companyId":{"type":"integer","minimum":0,"maximum":255},
                    "length":{"type":"integer","minimum":1,"maximum":256}
                }),
                json!(["connectorId", "query"]),
            ),
            ConnectorToolAction::QueryVictoria3 => strict_parameters(
                json!({
                    "connectorId":uuid_schema(),
                    "query":{"type":"string","enum":["get_state"]}
                }),
                json!(["connectorId"]),
            ),
            ConnectorToolAction::OpenTtdNewGrf => strict_parameters(
                json!({
                    "action":{"type":"string","enum":["list","place"]},
                    "source":{"type":"string","minLength":1,"maxLength":4096}
                }),
                json!(["action"]),
            ),
        };
        value
    }
    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        if matches!(
            self.action,
            ConnectorToolAction::List
                | ConnectorToolAction::Describe
                | ConnectorToolAction::Claim
                | ConnectorToolAction::Query
                | ConnectorToolAction::QueryOpenTtd
                | ConnectorToolAction::QueryVictoria3
        ) || (matches!(self.action, ConnectorToolAction::OpenTtdNewGrf)
            && arguments.get("action").and_then(Value::as_str) == Some("list"))
        {
            None
        } else {
            Some(PermissionRequest {
                permission: "connector.write".to_owned(),
                patterns: vec![
                    arguments
                        .get("connectorId")
                        .or_else(|| arguments.get("connectorKey"))
                        .map_or_else(|| "connector".to_owned(), Value::to_string),
                ],
                always: vec![],
            })
        }
    }
    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let args = &call.arguments;
        let result = match self.action {
            ConnectorToolAction::List => {
                let connectors = self
                    .service
                    .inner
                    .store
                    .list_connectors()
                    .await
                    .map_err(store_error)?;
                let connectors = connectors
                    .iter()
                    .map(|connector| connector_model_summary(&self.service, connector))
                    .collect::<Vec<_>>();
                json!({"count":connectors.len(),"connectors":connectors})
            }
            ConnectorToolAction::Describe => self
                .service
                .inner
                .manifests
                .describe_json(required(args, "connectorKey")?)
                .ok_or_else(|| {
                    ToolFailure::new(
                        "connector_not_found",
                        "the requested connector package is not installed",
                    )
                })?,
            ConnectorToolAction::Register => {
                let key = required(args, "connectorKey")?;
                let settings = args.get("settings").cloned().unwrap_or_else(|| json!({}));
                self.service
                    .validate_registration(key, &settings)
                    .map_err(|error| ToolFailure::new("invalid_connector_manifest", error))?;
                let connector = self
                    .service
                    .inner
                    .store
                    .register_connector(
                        key,
                        required(args, "identityKey")?,
                        args.get("displayName")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        args.get("desiredState")
                            .and_then(Value::as_str)
                            .unwrap_or("disconnected"),
                        settings,
                    )
                    .await
                    .map_err(store_error)?;
                json!({"connector":connector_model_summary(&self.service, &connector)})
            }
            ConnectorToolAction::SetState => {
                let connector = self
                    .service
                    .inner
                    .store
                    .update_connector(
                        id(args)?,
                        json!({"desiredState":required(args,"desiredState")?}),
                    )
                    .await
                    .map_err(store_error)?;
                json!({"connector":connector_model_summary(&self.service, &connector)})
            }
            ConnectorToolAction::Claim => serde_json::to_value(
                self.service
                    .inner
                    .store
                    .claim_connector_events(
                        id(args)?,
                        args.get("limit").and_then(Value::as_u64).unwrap_or(20) as u32,
                        60_000,
                    )
                    .await
                    .map_err(store_error)?,
            )
            .unwrap_or_default(),
            ConnectorToolAction::Finish => {
                let ids = args
                    .get("eventIds")
                    .and_then(Value::as_array)
                    .ok_or_else(|| ToolFailure::new("invalid_arguments", "eventIds is required"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .unwrap_or("")
                            .parse::<Uuid>()
                            .map_err(|error| ToolFailure::new("invalid_id", error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                self.service
                    .inner
                    .store
                    .finish_connector_events(
                        &ids,
                        args.get("retry").and_then(Value::as_bool).unwrap_or(false),
                    )
                    .await
                    .map_err(store_error)?;
                json!({"ok":true})
            }
            ConnectorToolAction::Execute => {
                let connector = self
                    .service
                    .inner
                    .store
                    .get_connector(id(args)?)
                    .await
                    .map_err(store_error)?;
                let mut payload = args.get("payload").cloned().unwrap_or_else(|| json!({}));
                if let Some(operation_id) = context.metadata.get("operationId").cloned()
                    && let Some(object) = payload.as_object_mut()
                {
                    object
                        .entry("operationId".to_owned())
                        .or_insert(operation_id);
                }
                self.service
                    .execute(&connector, required(args, "action")?, payload)
                    .await
                    .map_err(|error| ToolFailure::new("connector_action_failed", error))?
            }
            ConnectorToolAction::Query => {
                let connector = self
                    .service
                    .inner
                    .store
                    .get_connector(id(args)?)
                    .await
                    .map_err(store_error)?;
                self.service
                    .query(
                        &connector,
                        required(args, "query")?,
                        args.get("payload").cloned().unwrap_or_else(|| json!({})),
                    )
                    .await
                    .map_err(|error| ToolFailure::new("connector_query_failed", error))?
            }
            ConnectorToolAction::QueryOpenTtd => {
                let connector = self.open_ttd_connector(args).await?;
                let query = required(args, "query")?;
                let supported = [
                    "get_state",
                    "inspect_tile",
                    "find_towns",
                    "find_industries",
                    "get_company_assets",
                    "list_road_engines",
                    "find_road_route_site",
                ];
                if !supported.contains(&query) {
                    return Err(ToolFailure::new(
                        "unsupported_action",
                        format!("unsupported OpenTTD query: {query}"),
                    ));
                }
                let mut query_payload = json!({});
                for (source, target) in [
                    ("x", "x"),
                    ("y", "y"),
                    ("limit", "limit"),
                    ("companyId", "company_id"),
                    ("length", "length"),
                ] {
                    if let Some(value) = args.get(source).cloned() {
                        query_payload[target] = value;
                    }
                }
                self.service
                    .validate_query("openttd", query, &query_payload)
                    .map_err(|error| ToolFailure::new("invalid_connector_query", error))?;
                self.service
                    .query(&connector, query, query_payload)
                    .await
                    .map_err(|error| ToolFailure::new("openttd_query_failed", error))?
            }
            ConnectorToolAction::QueryVictoria3 => {
                let connector = self.victoria3_connector(args).await?;
                let query = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("get_state");
                if query != "get_state" {
                    return Err(ToolFailure::new(
                        "unsupported_action",
                        format!("unsupported Victoria 3 query: {query}"),
                    ));
                }
                self.service
                    .validate_query("victoria3", query, &json!({}))
                    .map_err(|error| ToolFailure::new("invalid_connector_query", error))?;
                self.service
                    .query(&connector, query, json!({}))
                    .await
                    .map_err(|error| ToolFailure::new("victoria3_query_failed", error))?
            }
            ConnectorToolAction::OpenTtdNewGrf => {
                let root = openttd_data_root()?;
                match required(args, "action")? {
                    "list" => serde_json::to_value(scan_newgrf(&root).map_err(|error| {
                        ToolFailure::new("openttd_newgrf_failed", error.to_string())
                    })?)
                    .unwrap_or_default(),
                    "place" => {
                        let source =
                            std::fs::canonicalize(required(args, "source")?).map_err(|error| {
                                ToolFailure::new("invalid_source", error.to_string())
                            })?;
                        if !source.is_file()
                            || source.extension().and_then(|value| value.to_str()) != Some("grf")
                        {
                            return Err(ToolFailure::new(
                                "invalid_source",
                                "source must be a regular .grf file",
                            ));
                        }
                        let target_root = root.join("newgrf");
                        std::fs::create_dir_all(&target_root).map_err(|error| {
                            ToolFailure::new("openttd_newgrf_failed", error.to_string())
                        })?;
                        let target = target_root.join(source.file_name().ok_or_else(|| {
                            ToolFailure::new("invalid_source", "source has no file name")
                        })?);
                        std::fs::copy(&source, &target).map_err(|error| {
                            ToolFailure::new("openttd_newgrf_failed", error.to_string())
                        })?;
                        json!({"placed":true,"path":target})
                    }
                    action => {
                        return Err(ToolFailure::new(
                            "unsupported_action",
                            format!("openttd_newgrf does not support {action}"),
                        ));
                    }
                }
            }
        };
        let mut output =
            ToolOutput::text(serde_json::to_string_pretty(&result).unwrap_or_default());
        output.details = result.clone();
        output.structured_content = Some(result);
        Ok(output)
    }
}
impl ConnectorTool {
    async fn open_ttd_connector(&self, args: &Value) -> Result<ConnectorRecord, ToolFailure> {
        let connectors = self
            .service
            .inner
            .store
            .list_connectors()
            .await
            .map_err(store_error)?;
        let requested = args
            .get("connectorId")
            .or_else(|| args.get("id"))
            .and_then(Value::as_str);
        connectors
            .into_iter()
            .find(|connector| {
                connector.connector_key == "openttd"
                    && requested.is_none_or(|id| connector.id.to_string() == id)
            })
            .ok_or_else(|| {
                ToolFailure::new(
                    "connector_not_found",
                    "no matching OpenTTD connector is registered",
                )
            })
    }

    async fn victoria3_connector(&self, args: &Value) -> Result<ConnectorRecord, ToolFailure> {
        let connectors = self
            .service
            .inner
            .store
            .list_connectors()
            .await
            .map_err(store_error)?;
        let requested = args
            .get("connectorId")
            .or_else(|| args.get("id"))
            .and_then(Value::as_str);
        connectors
            .into_iter()
            .find(|connector| {
                connector.connector_key == "victoria3"
                    && requested.is_none_or(|id| connector.id.to_string() == id)
            })
            .ok_or_else(|| {
                ToolFailure::new(
                    "connector_not_found",
                    "no matching Victoria 3 connector is registered",
                )
            })
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NewGrfFile {
    file: String,
    size: u64,
    source: String,
}

fn openttd_data_root() -> Result<std::path::PathBuf, ToolFailure> {
    if let Some(path) = std::env::var_os("OPENTTD_DATA_ROOT") {
        return Ok(path.into());
    }
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("OpenTTD"));
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .map(|path| path.join("Library/Application Support/OpenTTD"));
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let root = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|path| path.join(".local/share"))
        })
        .map(|path| path.join("openttd"));
    root.ok_or_else(|| {
        ToolFailure::new(
            "openttd_root_unavailable",
            "OpenTTD data directory could not be resolved",
        )
    })
}

fn scan_newgrf(root: &std::path::Path) -> std::io::Result<Vec<NewGrfFile>> {
    let mut files = Vec::new();
    for relative in ["newgrf", "content_download/newgrf"] {
        let directory = root.join(relative);
        if !directory.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("grf"))
            {
                files.push(NewGrfFile {
                    file: entry.file_name().to_string_lossy().into_owned(),
                    size: entry.metadata()?.len(),
                    source: relative.to_owned(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.file.cmp(&right.file));
    Ok(files)
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, ToolFailure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{key} is required")))
}
fn id(value: &Value) -> Result<Uuid, ToolFailure> {
    required(value, "connectorId")?
        .parse()
        .map_err(|error: uuid::Error| ToolFailure::new("invalid_id", error.to_string()))
}

fn uuid_schema() -> Value {
    json!({"type":"string","format":"uuid"})
}

fn strict_parameters(properties: Value, required: Value) -> Value {
    json!({
        "type":"object",
        "properties":properties,
        "required":required,
        "additionalProperties":false
    })
}

fn connector_model_summary(service: &ConnectorService, connector: &ConnectorRecord) -> Value {
    let error = connector
        .last_error
        .as_deref()
        .map(|value| value.chars().take(1_024).collect::<String>());
    json!({
        "id":connector.id,
        "connectorKey":connector.connector_key.clone(),
        "identityKey":connector.identity_key.clone(),
        "displayName":connector.display_name.clone(),
        "desiredState":connector.desired_state.clone(),
        "runtimeState":connector.runtime_state.clone(),
        "lastError":error,
        "contract":service.inner.manifests.model_contract(&connector.connector_key),
    })
}
fn store_error(error: eden_agent_store::StoreError) -> ToolFailure {
    ToolFailure::new("connector_store_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_core::event_channel;
    use tokio::io::AsyncWriteExt;

    fn tool_context() -> ToolCallContext {
        let (events, _receiver) = event_channel(8);
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: None,
            metadata: json!({}),
        }
    }

    fn stage_schema_package(root: &std::path::Path, manifest: &[u8]) {
        let value: Value = serde_json::from_slice(manifest).expect("connector package manifest");
        let id = value["id"].as_str().expect("connector package ID");
        let package = root.join(id);
        std::fs::create_dir_all(&package).expect("package directory");
        std::fs::write(package.join("connector.json"), manifest).expect("connector manifest");
        let platform = eden_agent_connector_package::current_platform();
        let worker = value["entrypoints"][platform]["path"]
            .as_str()
            .expect("current worker entrypoint");
        let worker = package.join(worker);
        std::fs::create_dir_all(worker.parent().expect("worker directory"))
            .expect("worker directory");
        std::fs::write(worker, b"schema-only worker").expect("worker placeholder");
    }

    #[test]
    fn plugin_worker_permissions_are_filtered_before_launch() {
        let root = tempfile::tempdir().expect("package root");
        std::fs::write(root.path().join("worker"), b"worker").expect("worker");
        std::fs::write(
            root.path().join("connector.json"),
            serde_json::to_vec(&json!({
                "schemaVersion":1,
                "id":"permission-worker",
                "name":"Permission Worker",
                "description":"permission filtering test",
                "version":"1.0.0",
                "protocolVersion":1,
                "icon":"cable",
                "entrypoints":{
                    eden_agent_connector_package::current_platform():{
                        "path":"worker","args":[]
                    }
                },
                "settingsSchema":{
                    "type":"object",
                    "properties":{"root":{"type":"string"}},
                    "required":["root"],
                    "additionalProperties":false
                },
                "permissions":[{
                    "capability":"filesystem.read",
                    "resource":"settings.root",
                    "access":"read",
                    "required":true,
                    "description":"Read configured root"
                }],
                "events":{},"queries":{},"actions":{}
            }))
            .expect("manifest JSON"),
        )
        .expect("manifest");
        let package = LoadedPackage::load(root.path(), LoadPolicy::Development).expect("package");
        let settings = json!({"root":"/safe/root"});
        assert!(resolve_package_permissions(&package, &settings, Some(&[])).is_empty());
        let grants = [ConnectorPermissionGrant {
            capability: "filesystem.read".to_owned(),
            resource: "settings.root".to_owned(),
            access: "read".to_owned(),
        }];
        let resolved = resolve_package_permissions(&package, &settings, Some(&grants));
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].resource, "/safe/root");
        let legacy = resolve_package_permissions(&package, &settings, None);
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].capability, resolved[0].capability);
        assert_eq!(legacy[0].resource, resolved[0].resource);
        assert_eq!(legacy[0].access, resolved[0].access);
    }

    #[tokio::test]
    async fn connector_tools_use_manifest_schemas_and_hide_settings_from_model_lists() {
        let packages = tempfile::tempdir().expect("packages");
        stage_schema_package(
            packages.path(),
            include_bytes!("../../../../Connectors/official/lichess/package/connector.json"),
        );
        stage_schema_package(
            packages.path(),
            include_bytes!("../../../../Connectors/official/openttd/package/connector.json"),
        );
        let store = Store::in_memory().await.expect("store");
        store
            .register_connector(
                "openttd",
                "local",
                "Local OpenTTD",
                "disconnected",
                json!({"passwordEnv":"MUST_NOT_REACH_MODEL","adminPort":3977}),
            )
            .await
            .expect("connector");
        let service = ConnectorService::with_config(
            store,
            ConnectorServiceConfig {
                package_root: packages.path().to_path_buf(),
                package_policy: LoadPolicy::Development,
                ..ConnectorServiceConfig::default()
            },
        )
        .expect("connector service");
        let tools = service.tools();
        let execute = tools
            .iter()
            .find(|tool| tool.definition().name == "execute_connector_action")
            .expect("execute tool");
        let execute_schema = execute.definition().parameters;
        assert_eq!(execute_schema["additionalProperties"], false);
        assert!(
            execute_schema["properties"]["action"]["enum"]
                .as_array()
                .is_some_and(|actions| actions.iter().any(|action| action == "gameplay_plan"))
        );
        assert!(
            execute_schema["properties"]["payload"]["properties"]
                .get("challenge_id")
                .is_some()
        );
        assert!(
            execute_schema["properties"]["payload"]["properties"]
                .get("commands")
                .is_some()
        );

        let register = tools
            .iter()
            .find(|tool| tool.definition().name == "register_connector")
            .expect("register tool");
        let register_schema = register.definition().parameters;
        assert_eq!(register_schema["additionalProperties"], false);
        assert!(
            register_schema["properties"]["connectorKey"]["enum"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|key| key == "lichess"))
        );

        let list = tools
            .iter()
            .find(|tool| tool.definition().name == "list_connectors")
            .expect("list tool");
        let output = list
            .execute(
                &ToolCall {
                    id: "list-connectors".to_owned(),
                    name: "list_connectors".to_owned(),
                    arguments: json!({}),
                },
                tool_context(),
            )
            .await
            .expect("list connectors");
        let structured = output.structured_content.expect("structured output");
        assert_eq!(structured["count"], 1);
        assert_eq!(structured["connectors"][0]["runtimeState"], "offline");
        assert_eq!(structured["connectors"][0]["contract"]["hotReload"], true);
        let serialized = structured.to_string();
        assert!(!serialized.contains("MUST_NOT_REACH_MODEL"));
        assert!(!serialized.contains("settings"));
    }

    #[tokio::test]
    async fn victoria3_connector_observes_bridge_log_and_disables_control_by_default() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::open(directory.path().join("agent.db"))
            .await
            .expect("store");
        let log_path = directory.path().join("debug.log");
        tokio::fs::write(&log_path, "Victoria 3 startup\n")
            .await
            .expect("seed log");
        let connector = store
            .register_connector(
                "victoria3",
                "local",
                "Victoria 3",
                "connected",
                json!({"logPath": log_path}),
            )
            .await
            .expect("register connector");
        let service = ConnectorService::new(store.clone()).expect("connector service");
        if service.inner.manifests.package("victoria3").is_none() {
            return;
        }
        service.reconcile().await;

        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .await
            .expect("open log");
        file.write_all(
            b"[EDENAGENT]|1|HELLO|bridge_version=0.1.0|mode=observe\n[EDENAGENT]|1|SNAPSHOT|date=1842.3.15|country_id=CHI|country_name=Great Qing\n",
        )
        .await
        .expect("append bridge lines");

        let mut state = None;
        for _ in 0..100 {
            if let Ok(value) = service.query(&connector, "get_state", json!({})).await {
                state = Some(value);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let mut state = state.expect("Victoria 3 package worker did not become ready");
        for _ in 0..20 {
            if !state["latestSnapshot"].is_null() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            state = service
                .query(&connector, "get_state", json!({}))
                .await
                .expect("Victoria 3 state");
        }
        assert_eq!(state["attached"], true);
        assert_eq!(state["bridgeSeen"], true);
        assert_eq!(
            state
                .get("latestSnapshot")
                .and_then(|snapshot| snapshot.get("fields"))
                .and_then(|fields| fields.get("country_id"))
                .and_then(Value::as_str),
            Some("CHI")
        );
        let events = store
            .claim_connector_events(connector.id, 10, 60_000)
            .await
            .expect("claim events");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "victoria3.snapshot")
        );
        assert!(
            service
                .execute(&connector, "pause", json!({}))
                .await
                .expect_err("unsupported connector action must be rejected")
                .contains("does not declare action")
        );
        assert!(
            service
                .execute(&connector, "probe_control", json!({}))
                .await
                .expect_err("control probe must be disabled by default")
                .contains("control is disabled")
        );

        if let Some(active) = service.inner.active.lock().await.get(&connector.id) {
            active.cancellation.cancel();
        }
    }

    #[tokio::test]
    async fn concurrent_reconciliation_is_single_flight_and_configuration_changes_are_isolated() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = Store::open(directory.path().join("agent.db"))
            .await
            .expect("store");
        let first = store
            .register_connector(
                "victoria3",
                "first",
                "First",
                "connected",
                json!({"logPath":directory.path().join("first.log")}),
            )
            .await
            .expect("first connector");
        let second = store
            .register_connector(
                "victoria3",
                "second",
                "Second",
                "connected",
                json!({"logPath":directory.path().join("second.log")}),
            )
            .await
            .expect("second connector");
        let service = ConnectorService::new(store.clone()).expect("connector service");
        if service.inner.manifests.package("victoria3").is_none() {
            return;
        }

        tokio::join!(
            service.reconcile(),
            service.reconcile(),
            service.reconcile()
        );
        let (first_cancellation, second_cancellation) = {
            let active = service.inner.active.lock().await;
            assert_eq!(active.len(), 2);
            (
                active
                    .get(&first.id)
                    .expect("first active")
                    .cancellation
                    .clone(),
                active
                    .get(&second.id)
                    .expect("second active")
                    .cancellation
                    .clone(),
            )
        };

        store
            .update_connector(
                first.id,
                json!({"settings":{"logPath":directory.path().join("first-new.log")}}),
            )
            .await
            .expect("update first connector");
        service.reconcile().await;
        assert!(first_cancellation.is_cancelled());
        assert!(!second_cancellation.is_cancelled());
        tokio::time::sleep(Duration::from_millis(25)).await;
        let (failed_generation, stable_generation) = {
            let active = service.inner.active.lock().await;
            assert_eq!(active.len(), 2);
            let replacement = active.get(&first.id).expect("replacement first worker");
            let unchanged = active.get(&second.id).expect("unchanged second worker");
            assert!(!replacement.cancellation.is_cancelled());
            assert!(!unchanged.cancellation.is_cancelled());
            (replacement.generation, unchanged.generation)
        };

        service
            .inner
            .active
            .lock()
            .await
            .get(&first.id)
            .expect("first worker before failure")
            ._task
            .abort();
        for _ in 0..20 {
            if service
                .inner
                .active
                .lock()
                .await
                .get(&first.id)
                .is_some_and(|active| active._task.is_finished())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            service
                .inner
                .active
                .lock()
                .await
                .get(&first.id)
                .is_some_and(|active| active._task.is_finished())
        );
        service.reconcile().await;
        {
            let active = service.inner.active.lock().await;
            assert_eq!(active.len(), 2);
            assert_ne!(
                active.get(&first.id).expect("restarted first").generation,
                failed_generation
            );
            assert_eq!(
                active.get(&second.id).expect("stable second").generation,
                stable_generation
            );
        }

        store
            .update_connector(second.id, json!({"desiredState":"disconnected"}))
            .await
            .expect("disconnect second connector");
        service.reconcile().await;
        assert!(second_cancellation.is_cancelled());
        let remaining = service.inner.active.lock().await;
        assert!(remaining.contains_key(&first.id));
        assert!(!remaining.contains_key(&second.id));
        remaining
            .get(&first.id)
            .expect("first remains active")
            .cancellation
            .cancel();
    }
}
