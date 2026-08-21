//! Durable connector lifecycle and connector-facing agent tools.

mod manifest;
mod openttd;

pub use manifest::ManifestCatalog;

use async_trait::async_trait;
use futures::StreamExt;
use mon_agent_connector_host::{WorkerClient, WorkerLaunchConfig, WorkerProcess};
use mon_agent_connector_package::{LoadPolicy, LoadedPackage, PackageCatalog};
use mon_agent_connector_protocol::{
    GrantedPermission, PublishedEvent, RpcNotification, WorkerStatus, method,
};
use mon_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use mon_agent_store::{ConnectorRecord, Store};
use mon_agent_victoria3::{
    ControlConfig as Victoria3ControlConfig, Controller as Victoria3Controller,
    Observation as Victoria3Observation, Observer as Victoria3Observer,
    ObserverConfig as Victoria3ObserverConfig, ObserverHandle as Victoria3Handle,
};
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position, fen::Fen, uci::UciMove};
use std::{
    collections::{HashMap, HashSet},
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
            || std::env::var_os("MON_AGENT_ALLOW_UNTRUSTED_CONNECTORS").as_deref()
                == Some(std::ffi::OsStr::new("1"))
        {
            LoadPolicy::Development
        } else {
            LoadPolicy::Production
        };
        Self {
            manifest_root: std::env::var_os("MON_AGENT_CONNECTOR_MANIFEST_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../connectors/manifests")
                }),
            package_root: std::env::var_os("MON_AGENT_CONNECTOR_PACKAGE_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("Data/connectors/packages")),
            package_policy,
            connector_data_root: std::env::var_os("MON_AGENT_CONNECTOR_DATA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("Data/connectors/runtime")),
        }
    }
}
struct Inner {
    store: Store,
    client: Client,
    stream_client: Client,
    reconcile_lock: Mutex<()>,
    active: Mutex<HashMap<Uuid, ActiveConnector>>,
    manifests: ManifestCatalog,
    packages: PackageCatalog,
    connector_data_root: PathBuf,
}
struct ActiveConnector {
    generation: Uuid,
    cancellation: CancellationToken,
    configuration: Value,
    worker: Option<Arc<RwLock<Option<WorkerClient>>>>,
    openttd: Option<openttd::Handle>,
    victoria3: Option<Victoria3Handle>,
    _task: JoinHandle<()>,
}

impl ConnectorService {
    pub fn new(store: Store) -> Result<Self, String> {
        Self::with_config(store, ConnectorServiceConfig::default())
    }

    pub fn with_config(store: Store, config: ConnectorServiceConfig) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(45))
            .user_agent("MonAgent/1.8")
            .build()
            .map_err(|error| error.to_string())?;
        // Long-lived NDJSON endpoints must not inherit the finite action timeout.
        let stream_client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent("MonAgent/1.8")
            .build()
            .map_err(|error| error.to_string())?;
        let packages = PackageCatalog::load(config.package_root, config.package_policy)
            .map_err(|error| error.to_string())?;
        let manifests =
            ManifestCatalog::load_with_packages(config.manifest_root, packages.clone())?;
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                client,
                stream_client,
                reconcile_lock: Mutex::new(()),
                active: Mutex::new(HashMap::new()),
                manifests,
                packages,
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
            let package = self.inner.packages.get(&connector.connector_key);
            let (openttd, openttd_commands) = if connector.connector_key == "openttd" {
                let (handle, commands) = openttd::channel();
                (Some(handle), Some(commands))
            } else {
                (None, None)
            };
            let worker = if package.is_some() {
                Some(Arc::new(RwLock::new(None)))
            } else {
                None
            };
            let (victoria3, victoria3_observer) = if connector.connector_key == "victoria3" {
                let config = Victoria3ObserverConfig::from_settings(&connector.settings);
                let (handle, observer) = Victoria3Observer::new(config);
                (Some(handle), Some(observer))
            } else {
                (None, None)
            };
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
                    .run_connector(
                        task_connector,
                        generation,
                        child,
                        package,
                        task_worker,
                        openttd_commands,
                        victoria3_observer,
                    )
                    .await;
            });
            self.inner.active.lock().await.insert(
                connector.id,
                ActiveConnector {
                    generation,
                    cancellation,
                    configuration: connector_configuration(&connector),
                    worker,
                    openttd,
                    victoria3,
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
        package: Option<LoadedPackage>,
        worker: Option<Arc<RwLock<Option<WorkerClient>>>>,
        openttd_commands: Option<tokio::sync::mpsc::Receiver<openttd::Command>>,
        victoria3_observer: Option<Victoria3Observer>,
    ) {
        let _ = self
            .inner
            .store
            .report_connector_state(connector.id, "connecting", None)
            .await;
        let result = if let Some(package) = package {
            self.run_package_worker(
                &connector,
                cancellation.clone(),
                package,
                worker.expect("external connector worker slot"),
            )
            .await
        } else {
            match connector.connector_key.as_str() {
                "lichess" => self.run_lichess(&connector, cancellation.clone()).await,
                "openttd" => {
                    openttd::run(
                        connector.clone(),
                        self.inner.store.clone(),
                        cancellation.clone(),
                        openttd_commands.expect("OpenTTD connector command channel"),
                    )
                    .await
                }
                "victoria3" => {
                    self.run_victoria3(
                        &connector,
                        cancellation.clone(),
                        victoria3_observer.expect("Victoria 3 observer"),
                    )
                    .await
                }
                key => Err(format!("unsupported connector: {key}")),
            }
        };
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
        launch.granted_permissions = resolve_package_permissions(&package, &connector.settings);
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

    async fn run_victoria3(
        &self,
        connector: &ConnectorRecord,
        cancellation: CancellationToken,
        observer: Victoria3Observer,
    ) -> Result<(), String> {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(64);
        let observer_cancellation = cancellation.clone();
        let mut observer_task = tokio::spawn(observer.run(observer_cancellation, sender));
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    observer_task.abort();
                    return Ok(());
                }
                result = &mut observer_task => {
                    return result.map_err(|error| error.to_string())?;
                }
                update = receiver.recv() => {
                    let Some(update) = update else {
                        return Err("Victoria 3 observer stopped without a result".to_owned());
                    };
                    if matches!(update, Victoria3Observation::Attached { .. }) {
                        self.inner
                            .store
                            .report_connector_state(connector.id, "connected", None)
                            .await
                            .map_err(|error| error.to_string())?;
                        continue;
                    }
                    if let (Some(external_id), Some(event_type)) =
                        (update.external_id(), update.event_type())
                    {
                        self.inner
                            .store
                            .publish_connector_event(
                                connector.id,
                                &external_id,
                                event_type,
                                update.payload(),
                            )
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
    }

    async fn run_lichess(
        &self,
        connector: &ConnectorRecord,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        let token_environment = lichess_token_environment(&connector.identity_key)?;
        let token = connector_token(connector, &token_environment)?;
        let base = connector
            .settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("https://lichess.org")
            .trim_end_matches('/');
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            response = self
                .inner
                .stream_client
                .get(format!("{base}/api/stream/event"))
                .header("Accept", "application/x-ndjson")
                .bearer_auth(&token)
                .send() => response.map_err(|error| error.to_string())?,
        };
        if !response.status().is_success() {
            return Err(format!("Lichess stream returned {}", response.status()));
        }
        self.inner
            .store
            .report_connector_state(connector.id, "connected", None)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut pending = Vec::<u8>::new();
        let game_cancellation = cancellation.child_token();
        let mut game_ids = HashSet::<String>::new();
        let mut game_tasks = tokio::task::JoinSet::new();
        let result = loop {
            tokio::select! {
                _ = cancellation.cancelled() => break Ok(()),
                completed = game_tasks.join_next(), if !game_tasks.is_empty() => {
                    if let Some(completed) = completed {
                        match completed {
                            Ok((game_id, Ok(()))) => {
                                game_ids.remove(&game_id);
                                tracing::debug!(connector_id = %connector.id, %game_id, "Lichess game stream ended");
                            }
                            Ok((game_id, Err(error))) => {
                                game_ids.remove(&game_id);
                                tracing::warn!(connector_id = %connector.id, %game_id, %error, "Lichess game stream failed");
                            }
                            Err(error) => tracing::warn!(connector_id = %connector.id, %error, "Lichess game stream task failed"),
                        }
                    }
                }
                chunk = stream.next() => match chunk {
                    Some(Ok(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        for payload in drain_ndjson(&mut pending)? {
                            let (event_type, external_id) = lichess_account_event(&payload);
                            self.inner.store
                                .publish_connector_event(
                                    connector.id,
                                    &external_id,
                                    &format!("lichess.{event_type}"),
                                    payload.clone(),
                                )
                                .await
                                .map_err(|error| error.to_string())?;
                            if let Some(game_id) = lichess_game_start_id(&payload)
                                && game_ids.insert(game_id.clone())
                            {
                                let service = self.clone();
                                let connector_id = connector.id;
                                let identity_key = connector.identity_key.clone();
                                let base = base.to_owned();
                                let token = token.clone();
                                let child = game_cancellation.child_token();
                                game_tasks.spawn(async move {
                                    let result = service
                                        .run_lichess_game(
                                            connector_id,
                                            &identity_key,
                                            &base,
                                            &token,
                                            &game_id,
                                            child,
                                        )
                                        .await;
                                    (game_id, result)
                                });
                            }
                        }
                    },
                    Some(Err(error)) => break Err(error.to_string()),
                    None => break Err("Lichess event stream ended".to_owned()),
                }
            }
        };
        game_cancellation.cancel();
        while let Some(completed) = game_tasks.join_next().await {
            if let Ok((game_id, Err(error))) = completed
                && !cancellation.is_cancelled()
            {
                tracing::warn!(connector_id = %connector.id, %game_id, %error, "Lichess game stream failed during shutdown");
            }
        }
        result
    }

    async fn run_lichess_game(
        &self,
        connector_id: Uuid,
        identity_key: &str,
        base: &str,
        token: &str,
        game_id: &str,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        let safe_game_id = safe_lichess_segment(game_id, "game_id")?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            response = self
                .inner
                .stream_client
                .get(format!("{base}/api/bot/game/stream/{safe_game_id}"))
                .header("Accept", "application/x-ndjson")
                .bearer_auth(token)
                .send() => response.map_err(|error| error.to_string())?,
        };
        if !response.status().is_success() {
            return Err(format!(
                "Lichess game stream {safe_game_id} returned {}",
                response.status()
            ));
        }
        let mut stream = response.bytes_stream();
        let mut pending = Vec::<u8>::new();
        let mut game_full = json!({});
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Ok(()),
                chunk = stream.next() => match chunk {
                    Some(Ok(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        for state in drain_ndjson(&mut pending)? {
                            match state.get("type").and_then(Value::as_str) {
                                Some("gameFull") => game_full = state.clone(),
                                Some("gameState") => {
                                    let object = game_full
                                        .as_object_mut()
                                        .ok_or("invalid cached Lichess game context")?;
                                    object.insert("state".to_owned(), state.clone());
                                }
                                _ => {}
                            }
                            let payload = json!({
                                "game_id": safe_game_id,
                                "raw": state,
                                "position": lichess_position(
                                    safe_game_id,
                                    identity_key,
                                    &game_full,
                                    &state,
                                ),
                            });
                            self.inner.store
                                .publish_connector_event(
                                    connector_id,
                                    &stable_event_id(&format!("game:{safe_game_id}"), &payload),
                                    "lichess.game_state",
                                    payload,
                                )
                                .await
                                .map_err(|error| error.to_string())?;
                        }
                    }
                    Some(Err(error)) => return Err(error.to_string()),
                    None => return Ok(()),
                }
            }
        }
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
        if self.inner.packages.get(&connector.connector_key).is_some() {
            let operation_id = payload
                .get("operationId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            return self
                .active_worker(connector.id)
                .await?
                .execute(action, schema_payload, operation_id)
                .await
                .map_err(|error| error.to_string());
        }
        match connector.connector_key.as_str() {
            "lichess" => self.execute_lichess(connector, action, payload).await,
            "openttd" => {
                let handle = self
                    .inner
                    .active
                    .lock()
                    .await
                    .get(&connector.id)
                    .and_then(|active| active.openttd.clone())
                    .ok_or("OpenTTD connector is not connected")?;
                handle.execute(action, payload).await
            }
            "victoria3" => match action {
                "probe_control" => {
                    let handle = self
                        .inner
                        .active
                        .lock()
                        .await
                        .get(&connector.id)
                        .and_then(|active| active.victoria3.clone())
                        .ok_or("Victoria 3 connector is not connected")?;
                    let state = handle.state().await;
                    let config =
                        Victoria3ControlConfig::from_settings(&connector.settings, &state.log_path);
                    let controller = Victoria3Controller::new(config, handle);
                    serde_json::to_value(controller.probe().await?)
                        .map_err(|error| error.to_string())
                }
                _ => Err(format!(
                    "Victoria 3 action {action} is not available; only the no-op control probe is implemented"
                )),
            },
            key => Err(format!("unsupported connector: {key}")),
        }
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
        if self.inner.packages.get(&connector.connector_key).is_none() {
            return Err(format!(
                "connector {} has not migrated to the package query protocol",
                connector.connector_key
            ));
        }
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
            .and_then(|active| active.worker.clone())
            .ok_or("connector package worker is not active")?;
        let client = slot.read().await.clone();
        client.ok_or_else(|| "connector package worker is still starting".to_owned())
    }

    async fn execute_lichess(
        &self,
        connector: &ConnectorRecord,
        action: &str,
        payload: Value,
    ) -> Result<Value, String> {
        let token_environment = lichess_token_environment(&connector.identity_key)?;
        let token = connector_token(connector, &token_environment)?;
        self.execute_lichess_authenticated(connector, action, payload, &token)
            .await
    }

    async fn execute_lichess_authenticated(
        &self,
        connector: &ConnectorRecord,
        action: &str,
        payload: Value,
        token: &str,
    ) -> Result<Value, String> {
        let base = connector
            .settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("https://lichess.org")
            .trim_end_matches('/');
        let request = lichess_action_request(action, &payload)?;
        let response = self
            .inner
            .client
            .post(format!("{base}{}", request.path))
            .bearer_auth(token)
            .form(&request.form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|error| error.to_string())?;
        if !status.is_success() {
            return Err(format!("Lichess returned {status}: {text}"));
        }
        Ok(
            json!({"ok":true,"status":status.as_u16(),"result":serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))}),
        )
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
) -> Vec<GrantedPermission> {
    package
        .manifest
        .permissions
        .iter()
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

fn connector_token(connector: &ConnectorRecord, fallback: &str) -> Result<String, String> {
    let name = connector
        .settings
        .get("tokenEnv")
        .and_then(Value::as_str)
        .unwrap_or(fallback);
    std::env::var(name)
        .map_err(|_| format!("connector credential environment variable is missing: {name}"))
        .and_then(|token| {
            let token = token.trim().to_owned();
            if token.is_empty() {
                Err(format!(
                    "connector credential environment variable is empty: {name}"
                ))
            } else {
                Ok(token)
            }
        })
}

fn lichess_token_environment(identity_key: &str) -> Result<String, String> {
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
        return Err("Lichess identity key does not contain an ASCII identifier".to_owned());
    }
    Ok(format!("MON_CONNECTOR_LICHESS_{identity}"))
}

fn drain_ndjson(pending: &mut Vec<u8>) -> Result<Vec<Value>, String> {
    const MAX_NDJSON_RECORD_BYTES: usize = 4 * 1024 * 1024;
    let mut values = Vec::new();
    while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
        let line = pending.drain(..=index).collect::<Vec<_>>();
        if line.len() > MAX_NDJSON_RECORD_BYTES {
            return Err("Lichess NDJSON record exceeds 4 MiB".to_owned());
        }
        let line = std::str::from_utf8(&line).map_err(|error| error.to_string())?;
        let line = line.trim();
        if !line.is_empty() {
            values.push(serde_json::from_str(line).map_err(|error| error.to_string())?);
        }
    }
    if pending.len() > MAX_NDJSON_RECORD_BYTES {
        return Err("Lichess NDJSON record exceeds 4 MiB".to_owned());
    }
    Ok(values)
}

fn stable_event_id(prefix: &str, payload: &Value) -> String {
    if let Some(id) = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return format!("{prefix}:{id}");
    }
    let bytes = serde_json::to_vec(payload).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    let suffix = digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}:{suffix}")
}

fn lichess_account_event(payload: &Value) -> (String, String) {
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .filter(|event_type| !event_type.is_empty())
        .unwrap_or("account_event")
        .to_owned();
    (event_type, stable_event_id("account", payload))
}

fn lichess_game_start_id(payload: &Value) -> Option<String> {
    (payload.get("type").and_then(Value::as_str) == Some("gameStart"))
        .then(|| {
            payload
                .get("game")
                .and_then(|game| game.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .flatten()
}

#[derive(Debug, PartialEq, Eq)]
struct LichessActionRequest {
    path: String,
    form: Vec<(String, String)>,
}

fn safe_lichess_segment<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{label} is not a safe Lichess identifier"));
    }
    Ok(value)
}

fn lichess_action_request(action: &str, payload: &Value) -> Result<LichessActionRequest, String> {
    let game_id = payload
        .get("game_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let challenge_id = payload
        .get("challenge_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let request = match action {
        "accept_challenge" => {
            let challenge_id = safe_lichess_segment(challenge_id, "challenge_id")?;
            LichessActionRequest {
                path: format!("/api/challenge/{challenge_id}/accept"),
                form: vec![],
            }
        }
        "decline_challenge" => {
            let challenge_id = safe_lichess_segment(challenge_id, "challenge_id")?;
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("generic");
            if !matches!(
                reason,
                "generic"
                    | "later"
                    | "tooFast"
                    | "tooSlow"
                    | "timeControl"
                    | "rated"
                    | "casual"
                    | "standard"
                    | "variant"
                    | "noBot"
                    | "onlyBot"
            ) {
                return Err("invalid Lichess decline reason".to_owned());
            }
            LichessActionRequest {
                path: format!("/api/challenge/{challenge_id}/decline"),
                form: vec![("reason".to_owned(), reason.to_owned())],
            }
        }
        "make_move" => {
            let game_id = safe_lichess_segment(game_id, "game_id")?;
            let move_uci = payload
                .get("move")
                .and_then(Value::as_str)
                .ok_or("move is required")?;
            let parsed = move_uci
                .parse::<UciMove>()
                .map_err(|error| format!("invalid UCI move: {error}"))?;
            if !parsed.is_normal() {
                return Err("Lichess move must be a normal UCI move".to_owned());
            }
            LichessActionRequest {
                path: format!("/api/bot/game/{game_id}/move/{move_uci}"),
                form: vec![(
                    "offeringDraw".to_owned(),
                    payload
                        .get("offer_draw")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        .to_string(),
                )],
            }
        }
        "resign" => {
            let game_id = safe_lichess_segment(game_id, "game_id")?;
            LichessActionRequest {
                path: format!("/api/bot/game/{game_id}/resign"),
                form: vec![],
            }
        }
        "offer_draw" => {
            let game_id = safe_lichess_segment(game_id, "game_id")?;
            LichessActionRequest {
                path: format!("/api/bot/game/{game_id}/draw/yes"),
                form: vec![],
            }
        }
        "send_chat" => {
            let game_id = safe_lichess_segment(game_id, "game_id")?;
            let room = payload
                .get("room")
                .and_then(Value::as_str)
                .unwrap_or("player");
            if !matches!(room, "player" | "spectator") {
                return Err("invalid Lichess chat room".to_owned());
            }
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or("text is required")?;
            LichessActionRequest {
                path: format!("/api/bot/game/{game_id}/chat"),
                form: vec![
                    ("room".to_owned(), room.to_owned()),
                    ("text".to_owned(), text.to_owned()),
                ],
            }
        }
        _ => return Err("invalid Lichess action or parameters".to_owned()),
    };
    Ok(request)
}

fn lichess_position(game_id: &str, identity_key: &str, game_full: &Value, latest: &Value) -> Value {
    let latest_type = latest.get("type").and_then(Value::as_str);
    let state = match latest_type {
        Some("gameFull") => latest.get("state"),
        Some("gameState") => Some(latest),
        _ => game_full.get("state"),
    }
    .filter(|state| state.is_object())
    .unwrap_or(&Value::Null);
    let moves = state
        .get("moves")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>();
    let initial_fen = game_full
        .get("initialFen")
        .and_then(Value::as_str)
        .unwrap_or("startpos");
    let variant = game_full
        .get("variant")
        .and_then(|variant| variant.get("key").or_else(|| variant.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("standard");
    let white = game_full.get("white").unwrap_or(&Value::Null);
    let black = game_full.get("black").unwrap_or(&Value::Null);
    let white_id = white
        .get("id")
        .or_else(|| white.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let black_id = black
        .get("id")
        .or_else(|| black.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let bot_color = if white_id.eq_ignore_ascii_case(identity_key) {
        Some("white")
    } else if black_id.eq_ignore_ascii_case(identity_key) {
        Some("black")
    } else {
        None
    };
    let fallback_side = if moves.len() % 2 == 0 {
        "white"
    } else {
        "black"
    };
    let mut result = json!({
        "game_id": game_id,
        "variant": variant,
        "initial_fen": initial_fen,
        "moves_uci": moves,
        "ply": moves.len(),
        "side_to_move": fallback_side,
        "bot_color": bot_color,
        "is_bot_turn": bot_color == Some(fallback_side),
        "white": {
            "id": white_id,
            "rating": white.get("rating"),
            "title": white.get("title"),
        },
        "black": {
            "id": black_id,
            "rating": black.get("rating"),
            "title": black.get("title"),
        },
        "status": state.get("status").and_then(Value::as_str).unwrap_or("started"),
        "winner": state.get("winner"),
        "white_time_ms": state.get("wtime"),
        "black_time_ms": state.get("btime"),
        "white_increment_ms": state.get("winc"),
        "black_increment_ms": state.get("binc"),
        "draw_offer_by_white": state.get("wdraw").and_then(Value::as_bool).unwrap_or(false),
        "draw_offer_by_black": state.get("bdraw").and_then(Value::as_bool).unwrap_or(false),
    });
    let chess = if matches!(variant, "standard" | "fromPosition") {
        standard_chess_position(initial_fen, &moves)
    } else {
        Err(format!("unsupported Lichess chess variant: {variant}"))
    };
    match chess {
        Ok(position) => {
            let side_to_move = match position.turn() {
                Color::White => "white",
                Color::Black => "black",
            };
            let legal_moves = position
                .legal_moves()
                .into_iter()
                .map(UciMove::from_standard)
                .map(|move_uci| move_uci.to_string())
                .collect::<Vec<_>>();
            let details = json!({
                "fen": Fen::from_position(&position, EnPassantMode::Legal).to_string(),
                "legal_moves_uci": legal_moves,
                "check": position.is_check(),
                "checkmate": position.is_checkmate(),
                "stalemate": position.is_stalemate(),
                "position_valid": true,
                "side_to_move": side_to_move,
                "is_bot_turn": bot_color == Some(side_to_move),
            });
            if let (Some(result), Some(details)) = (result.as_object_mut(), details.as_object()) {
                result.extend(details.clone());
            }
        }
        Err(error) => {
            if let Some(result) = result.as_object_mut() {
                result.insert("position_valid".to_owned(), Value::Bool(false));
                result.insert("position_error".to_owned(), Value::String(error));
                result.insert("legal_moves_uci".to_owned(), json!([]));
            }
        }
    }
    result
}

fn standard_chess_position(initial_fen: &str, moves: &[&str]) -> Result<Chess, String> {
    let mut position = if initial_fen == "startpos" {
        Chess::default()
    } else {
        let fen = initial_fen
            .parse::<Fen>()
            .map_err(|error| error.to_string())?;
        fen.into_position(CastlingMode::Standard)
            .map_err(|error| error.to_string())?
    };
    for move_uci in moves {
        let move_uci = move_uci
            .parse::<UciMove>()
            .map_err(|error| error.to_string())?;
        let chess_move = move_uci
            .to_move(&position)
            .map_err(|error| error.to_string())?;
        position.play_unchecked(chess_move);
    }
    Ok(position)
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
                let action = if query == "get_state" {
                    "refresh_state"
                } else {
                    "gameplay_command"
                };
                let mut command = json!({"action":query});
                let mut query_payload = json!({});
                for (source, target) in [
                    ("x", "x"),
                    ("y", "y"),
                    ("limit", "limit"),
                    ("companyId", "company_id"),
                    ("length", "length"),
                ] {
                    if let Some(value) = args.get(source).cloned() {
                        command[target] = value.clone();
                        query_payload[target] = value;
                    }
                }
                self.service
                    .validate_query("openttd", query, &query_payload)
                    .map_err(|error| ToolFailure::new("invalid_connector_query", error))?;
                let payload = if action == "refresh_state" {
                    json!({})
                } else {
                    json!({"command":command})
                };
                self.service
                    .execute(&connector, action, payload)
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
                let handle = self
                    .service
                    .inner
                    .active
                    .lock()
                    .await
                    .get(&connector.id)
                    .and_then(|active| active.victoria3.clone())
                    .ok_or_else(|| {
                        ToolFailure::new(
                            "victoria3_not_connected",
                            "Victoria 3 observer connector is not active",
                        )
                    })?;
                serde_json::to_value(handle.state().await).unwrap_or_default()
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
fn store_error(error: mon_agent_store::StoreError) -> ToolFailure {
    ToolFailure::new("connector_store_failed", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_core::event_channel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn tool_context() -> ToolCallContext {
        let (events, _receiver) = event_channel(8);
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: None,
            metadata: json!({}),
        }
    }

    #[tokio::test]
    async fn connector_tools_use_manifest_schemas_and_hide_settings_from_model_lists() {
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
        let service = ConnectorService::new(store).expect("connector service");
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
    async fn lichess_action_sends_exact_authenticated_http_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            let expected_length = loop {
                let mut chunk = [0_u8; 1024];
                let read = socket.read(&mut chunk).await.expect("read request");
                assert_ne!(read, 0, "request ended before headers");
                request.extend_from_slice(&chunk[..read]);
                let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().expect("content length"))
                        })
                    })
                    .expect("content length");
                if request.len() >= header_end + 4 + length {
                    break header_end + 4 + length;
                }
            };
            request.truncate(expected_length);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .await
                .expect("response");
            String::from_utf8(request).expect("HTTP request")
        });
        let store = Store::in_memory().await.expect("store");
        let service = ConnectorService::new(store).expect("connector service");
        let connector = ConnectorRecord {
            id: Uuid::now_v7(),
            connector_key: "lichess".to_owned(),
            identity_key: "test-bot".to_owned(),
            display_name: "Test Bot".to_owned(),
            desired_state: "disconnected".to_owned(),
            runtime_state: "offline".to_owned(),
            settings: json!({"baseUrl":format!("http://{address}")}),
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        service
            .inner
            .manifests
            .validate_action(
                "lichess",
                "decline_challenge",
                &json!({"challenge_id":"challenge-1","reason":"later"}),
            )
            .expect("manifest action");
        let response = service
            .execute_lichess_authenticated(
                &connector,
                "decline_challenge",
                json!({"challenge_id":"challenge-1","reason":"later"}),
                "secret-token",
            )
            .await
            .expect("Lichess response");
        assert_eq!(response["ok"], true);
        let request = server.await.expect("server task");
        let request_lower = request.to_ascii_lowercase();
        assert!(request.starts_with("POST /api/challenge/challenge-1/decline HTTP/1.1\r\n"));
        assert!(request_lower.contains("authorization: bearer secret-token\r\n"));
        assert!(request_lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(request.ends_with("reason=later"));
    }

    #[test]
    fn lichess_identity_uses_an_isolated_credential_namespace() {
        assert_eq!(
            lichess_token_environment(" Alice / tournament-bot ").expect("environment"),
            "MON_CONNECTOR_LICHESS_ALICE_TOURNAMENT_BOT"
        );
        assert!(lichess_token_environment("_ / _").is_err());
    }

    #[test]
    fn lichess_ndjson_framing_keeps_partial_records() {
        let mut pending = br#"{"type":"challenge"}
{"type":"gameStart","game":{"id":"abc123"}}"#
            .to_vec();
        let first = drain_ndjson(&mut pending).expect("first record");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["type"], "challenge");
        assert!(!pending.is_empty());

        pending.extend_from_slice(b"\n");
        let second = drain_ndjson(&mut pending).expect("second record");
        assert_eq!(second.len(), 1);
        assert_eq!(lichess_game_start_id(&second[0]).as_deref(), Some("abc123"));
        assert!(pending.is_empty());
    }

    #[test]
    fn lichess_account_event_ids_are_deterministic() {
        let payload = json!({"type":"challenge","challenge":{"id":"c1"}});
        let first = lichess_account_event(&payload);
        let second = lichess_account_event(&payload);
        assert_eq!(first, second);
        assert_eq!(first.0, "challenge");
        assert!(first.1.starts_with("account:"));
    }

    #[test]
    fn lichess_actions_use_exact_safe_paths_and_form_values() {
        assert_eq!(
            lichess_action_request(
                "make_move",
                &json!({"game_id":"game123","move":"e7e8q","offer_draw":true}),
            )
            .expect("move request"),
            LichessActionRequest {
                path: "/api/bot/game/game123/move/e7e8q".to_owned(),
                form: vec![("offeringDraw".to_owned(), "true".to_owned())],
            }
        );
        assert_eq!(
            lichess_action_request(
                "send_chat",
                &json!({"game_id":"game123","room":"spectator","text":"good game"}),
            )
            .expect("chat request")
            .form,
            vec![
                ("room".to_owned(), "spectator".to_owned()),
                ("text".to_owned(), "good game".to_owned()),
            ]
        );
        assert!(lichess_action_request("resign", &json!({"game_id":"../another-game"}),).is_err());
        assert!(
            lichess_action_request("make_move", &json!({"game_id":"game123","move":"0000"}),)
                .is_err()
        );
    }

    #[test]
    fn lichess_position_replays_moves_and_exposes_agent_ready_state() {
        let game_full = json!({
            "type":"gameFull",
            "initialFen":"startpos",
            "variant":{"key":"standard"},
            "white":{"id":"WhiteBot","rating":2100,"title":"BOT"},
            "black":{"id":"Opponent","rating":2050},
            "state":{
                "type":"gameState",
                "moves":"e2e4 e7e5",
                "wtime":59000,
                "btime":58000,
                "winc":1000,
                "binc":1000,
                "status":"started"
            }
        });
        let position = lichess_position("game123", "whitebot", &game_full, &game_full);
        assert_eq!(position["position_valid"], true);
        assert_eq!(position["ply"], 2);
        assert_eq!(position["side_to_move"], "white");
        assert_eq!(position["bot_color"], "white");
        assert_eq!(position["is_bot_turn"], true);
        assert_eq!(position["white_time_ms"], 59000);
        assert_eq!(
            position["fen"],
            "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"
        );
        assert!(
            position["legal_moves_uci"]
                .as_array()
                .expect("legal moves")
                .iter()
                .any(|move_uci| move_uci.as_str() == Some("g1f3"))
        );
    }

    #[test]
    fn lichess_position_respects_initial_fen_turn_and_rejects_unknown_variants() {
        let game_full = json!({
            "type":"gameFull",
            "initialFen":"8/8/8/8/8/8/4K3/6k1 b - - 0 1",
            "variant":{"key":"fromPosition"},
            "state":{"type":"gameState","moves":"","status":"started"}
        });
        let position = lichess_position("fen-game", "nobody", &game_full, &game_full);
        assert_eq!(position["position_valid"], true);
        assert_eq!(position["side_to_move"], "black");

        let unsupported = json!({
            "type":"gameFull",
            "variant":{"key":"atomic"},
            "state":{"type":"gameState","moves":"e2e4"}
        });
        let position = lichess_position("atomic-game", "nobody", &unsupported, &unsupported);
        assert_eq!(position["position_valid"], false);
        assert!(
            position["position_error"]
                .as_str()
                .expect("position error")
                .contains("unsupported")
        );
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
        service.reconcile().await;

        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .await
            .expect("open log");
        file.write_all(
            b"[MONAGENT]|1|HELLO|bridge_version=0.1.0|mode=observe\n[MONAGENT]|1|SNAPSHOT|date=1842.3.15|country_id=CHI|country_name=Great Qing\n",
        )
        .await
        .expect("append bridge lines");

        let handle = service
            .inner
            .active
            .lock()
            .await
            .get(&connector.id)
            .and_then(|active| active.victoria3.clone())
            .expect("Victoria 3 handle");
        let mut state = handle.state().await;
        for _ in 0..20 {
            if state.latest_snapshot.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            state = handle.state().await;
        }
        assert!(state.attached);
        assert!(state.bridge_seen);
        assert_eq!(
            state
                .latest_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.fields.get("country_id"))
                .map(String::as_str),
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
