//! Supervision and RPC client for isolated Connector Worker processes.

use mon_agent_connector_package::{LoadedPackage, PackageError};
use mon_agent_connector_protocol::{
    CapabilityCall, FrameError, GrantedPermission, InitializeParams, InitializeResult, RpcRequest,
    RpcResponse, WireMessage, method, read_message, write_message,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::AsyncReadExt,
    process::{ChildStdin, Command},
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct WorkerLaunchConfig {
    pub package: LoadedPackage,
    pub instance_id: String,
    pub settings: Value,
    pub granted_permissions: Vec<GrantedPermission>,
    pub data_directory: PathBuf,
    pub request_timeout: Duration,
    pub environment: BTreeMap<String, String>,
}

impl WorkerLaunchConfig {
    #[must_use]
    pub fn new(
        package: LoadedPackage,
        instance_id: impl Into<String>,
        settings: Value,
        data_directory: PathBuf,
    ) -> Self {
        Self {
            package,
            instance_id: instance_id.into(),
            settings,
            granted_permissions: Vec::new(),
            data_directory,
            request_timeout: Duration::from_secs(30),
            environment: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub struct WorkerClient {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    writer: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<RpcResponse, String>>>>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl WorkerClient {
    pub async fn request(&self, method_name: &str, params: Value) -> Result<Value, WorkerError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        let message = WireMessage::Request(RpcRequest {
            id,
            method: method_name.to_owned(),
            params,
        });
        if let Err(error) = write_message(&mut *self.inner.writer.lock().await, &message).await {
            self.inner.pending.lock().await.remove(&id);
            return Err(WorkerError::Protocol(error));
        }
        let response = tokio::time::timeout(self.inner.timeout, receiver)
            .await
            .map_err(|_| WorkerError::Timeout(method_name.to_owned()))?
            .map_err(|_| WorkerError::Exited)?
            .map_err(WorkerError::Transport)?;
        response.into_result().map_err(WorkerError::Remote)
    }

    pub async fn health(&self) -> Result<Value, WorkerError> {
        self.request(method::HEALTH, json!({})).await
    }

    pub async fn query(&self, capability: &str, payload: Value) -> Result<Value, WorkerError> {
        self.request(
            method::QUERY,
            serde_json::to_value(CapabilityCall {
                capability: capability.to_owned(),
                payload,
                operation_id: None,
            })?,
        )
        .await
    }

    pub async fn execute(
        &self,
        capability: &str,
        payload: Value,
        operation_id: Option<String>,
    ) -> Result<Value, WorkerError> {
        self.request(
            method::EXECUTE,
            serde_json::to_value(CapabilityCall {
                capability: capability.to_owned(),
                payload,
                operation_id,
            })?,
        )
        .await
    }
}

pub struct WorkerProcess {
    client: WorkerClient,
    notifications: mpsc::Receiver<mon_agent_connector_protocol::RpcNotification>,
    cancellation: CancellationToken,
    process_task: JoinHandle<Result<std::process::ExitStatus, std::io::Error>>,
    reader_task: JoinHandle<Result<(), WorkerError>>,
    stderr_task: JoinHandle<()>,
    pub initialization: InitializeResult,
}

impl WorkerProcess {
    pub async fn launch(config: WorkerLaunchConfig) -> Result<Self, WorkerError> {
        let entrypoint = config.package.current_entrypoint()?;
        std::fs::create_dir_all(&config.data_directory)?;
        let data_directory = std::fs::canonicalize(&config.data_directory)?;
        let mut command = Command::new(&entrypoint.executable);
        command
            .args(&entrypoint.args)
            .current_dir(&config.package.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear();
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for (key, value) in &config.environment {
            command.env(key, value);
        }
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or(WorkerError::MissingPipe("stdin"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or(WorkerError::MissingPipe("stdout"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or(WorkerError::MissingPipe("stderr"))?;
        let cancellation = CancellationToken::new();
        let process_cancellation = cancellation.clone();
        let process_task = tokio::spawn(async move {
            tokio::select! {
                result = child.wait() => result,
                _ = process_cancellation.cancelled() => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            }
        });
        let inner = Arc::new(ClientInner {
            writer: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            timeout: config.request_timeout,
        });
        let (notification_sender, notifications) = mpsc::channel(128);
        let reader_inner = Arc::clone(&inner);
        let reader_task = tokio::spawn(async move {
            loop {
                match read_message(&mut stdout).await? {
                    Some(WireMessage::Response(response)) => {
                        if let Some(waiter) = reader_inner.pending.lock().await.remove(&response.id)
                        {
                            let _ = waiter.send(Ok(response));
                        }
                    }
                    Some(WireMessage::Notification(notification)) => {
                        if notification_sender.send(notification).await.is_err() {
                            break;
                        }
                    }
                    Some(WireMessage::Request(request)) => {
                        return Err(WorkerError::UnexpectedRequest(request.method));
                    }
                    None => break,
                }
            }
            fail_pending(&reader_inner, "worker protocol stream closed").await;
            Ok(())
        });
        let package_id = config.package.manifest.id.clone();
        let stderr_task = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let message = String::from_utf8_lossy(&buffer[..read]);
                        tracing::info!(connector_package = %package_id, worker_stderr = %message.trim_end());
                    }
                }
            }
        });
        let client = WorkerClient { inner };
        let initialization_value = client
            .request(
                method::INITIALIZE,
                serde_json::to_value(InitializeParams {
                    protocol_version: mon_agent_connector_protocol::PROTOCOL_VERSION,
                    connector_instance_id: config.instance_id,
                    connector_key: config.package.manifest.id.clone(),
                    package_version: config.package.manifest.version.clone(),
                    settings: config.settings,
                    granted_permissions: config.granted_permissions,
                    data_directory: data_directory.to_string_lossy().into_owned(),
                })?,
            )
            .await;
        let initialization: InitializeResult = match initialization_value {
            Ok(value) => serde_json::from_value(value)?,
            Err(error) => {
                cancellation.cancel();
                return Err(error);
            }
        };
        if initialization.protocol_version != mon_agent_connector_protocol::PROTOCOL_VERSION {
            cancellation.cancel();
            return Err(WorkerError::ProtocolVersion {
                expected: mon_agent_connector_protocol::PROTOCOL_VERSION,
                actual: initialization.protocol_version,
            });
        }
        validate_capabilities(&config.package, &initialization.capabilities)?;
        Ok(Self {
            client,
            notifications,
            cancellation,
            process_task,
            reader_task,
            stderr_task,
            initialization,
        })
    }

    #[must_use]
    pub fn client(&self) -> WorkerClient {
        self.client.clone()
    }

    pub async fn recv_notification(
        &mut self,
    ) -> Option<mon_agent_connector_protocol::RpcNotification> {
        self.notifications.recv().await
    }

    pub async fn shutdown(mut self) -> Result<(), WorkerError> {
        let _ = self.client.request(method::SHUTDOWN, json!({})).await;
        let status =
            match tokio::time::timeout(Duration::from_secs(5), &mut self.process_task).await {
                Ok(result) => result.map_err(|error| WorkerError::Join(error.to_string()))??,
                Err(_) => {
                    self.cancellation.cancel();
                    (&mut self.process_task)
                        .await
                        .map_err(|error| WorkerError::Join(error.to_string()))??
                }
            };
        self.reader_task.abort();
        self.stderr_task.abort();
        if status.success() {
            Ok(())
        } else {
            Err(WorkerError::ExitStatus(status.to_string()))
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

fn validate_capabilities(
    package: &LoadedPackage,
    capabilities: &[String],
) -> Result<(), WorkerError> {
    let declared = package
        .manifest
        .events
        .keys()
        .chain(package.manifest.queries.keys())
        .chain(package.manifest.actions.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(unknown) = capabilities.iter().find(|name| !declared.contains(*name)) {
        return Err(WorkerError::UndeclaredCapability(unknown.clone()));
    }
    Ok(())
}

async fn fail_pending(inner: &ClientInner, message: &str) {
    for (_, waiter) in inner.pending.lock().await.drain() {
        let _ = waiter.send(Err(message.to_owned()));
    }
}

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error(transparent)]
    Package(#[from] PackageError),
    #[error(transparent)]
    Protocol(#[from] FrameError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("worker did not expose its {0} pipe")]
    MissingPipe(&'static str),
    #[error("worker exited while a request was pending")]
    Exited,
    #[error("worker transport failed: {0}")]
    Transport(String),
    #[error("worker request timed out: {0}")]
    Timeout(String),
    #[error("worker returned an error: {0}")]
    Remote(#[from] mon_agent_connector_protocol::RpcError),
    #[error("worker sent an unsupported host request: {0}")]
    UnexpectedRequest(String),
    #[error("worker negotiated protocol {actual}, expected {expected}")]
    ProtocolVersion { expected: u32, actual: u32 },
    #[error("worker announced an undeclared capability: {0}")]
    UndeclaredCapability(String),
    #[error("worker process task failed: {0}")]
    Join(String),
    #[error("worker exited unsuccessfully: {0}")]
    ExitStatus(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_connector_package::{ConnectorPackageManifest, IntegrityState};

    #[test]
    fn rejects_capabilities_not_declared_by_the_package() {
        let package = LoadedPackage {
            root: PathBuf::from("."),
            manifest: ConnectorPackageManifest {
                schema_version: 1,
                id: "test.connector".to_owned(),
                name: "Test".to_owned(),
                description: "Test package".to_owned(),
                version: "1.0.0".to_owned(),
                protocol_version: 1,
                icon: "test".to_owned(),
                entrypoints: BTreeMap::new(),
                settings_schema: json!({"type":"object","additionalProperties":false}),
                permissions: Vec::new(),
                events: BTreeMap::new(),
                queries: BTreeMap::from([("get_state".to_owned(), json!({}))]),
                actions: BTreeMap::new(),
                assets: Vec::new(),
                skill: None,
            },
            revision: "test".to_owned(),
            integrity: IntegrityState::UnverifiedDevelopment,
        };
        assert!(validate_capabilities(&package, &["get_state".to_owned()]).is_ok());
        assert!(matches!(
            validate_capabilities(&package, &["undeclared".to_owned()]),
            Err(WorkerError::UndeclaredCapability(_))
        ));
    }
}
