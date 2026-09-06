use super::*;
use eden_agent_tools::{native_shell_path, probe_process_sandbox};
use tokio::sync::RwLock as AsyncRwLock;

const CONFIG_KEY: &str = "command.execution";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandExecutionSettings {
    pub mode: String,
    pub network_access: bool,
    pub writable_roots: Vec<String>,
}

impl Default for CommandExecutionSettings {
    fn default() -> Self {
        Self {
            mode: "sandbox".into(),
            network_access: false,
            writable_roots: Vec::new(),
        }
    }
}

impl CommandExecutionSettings {
    fn value(&self) -> Value {
        json!({"mode":self.mode,"networkAccess":self.network_access,"writableRoots":self.writable_roots})
    }
}

pub struct CommandExecutionStatus {
    pub settings: CommandExecutionSettings,
    pub available: bool,
    pub sandbox_available: bool,
    pub sandbox_backend: String,
    pub shell: String,
    pub detail: String,
}

pub(super) struct CommandExecution {
    pub(super) sandbox: ProcessSandbox,
    sandbox_backend: String,
    sandbox_detail: String,
    settings: RwLock<CommandExecutionSettings>,
    pub(super) gate: AsyncRwLock<()>,
}

impl CommandExecution {
    pub(super) async fn initialize(
        store: &Store,
        sandbox: ProcessSandbox,
        root: &Path,
    ) -> Result<Self, String> {
        let sandbox_backend = match &sandbox {
            ProcessSandbox::Bubblewrap(_) | ProcessSandbox::BubblewrapWithAccess { .. } => {
                "bubblewrap"
            }
            ProcessSandbox::External(_) => "external",
            _ => "unavailable",
        }
        .to_owned();
        // Direct is never accepted as a sandbox. Host execution has its own explicit setting.
        let (sandbox, sandbox_detail) =
            if matches!(sandbox, ProcessSandbox::Disabled | ProcessSandbox::Direct) {
                (
                    ProcessSandbox::Disabled,
                    "没有可用的 OS 沙箱。可配置隔离器，或由用户在权限菜单选择本机执行。".into(),
                )
            } else {
                match probe_process_sandbox(&sandbox, root).await {
                    Ok(()) => (sandbox, "沙箱启动探测通过".into()),
                    Err(error) => (
                        ProcessSandbox::Disabled,
                        format!("沙箱启动探测失败：{}", error.message),
                    ),
                }
            };
        let persisted = store
            .get_config(CONFIG_KEY)
            .await
            .map_err(|error| error.to_string())?;
        let mut settings = CommandExecutionSettings::default();
        if let Some(value) = persisted {
            settings.mode = value
                .get("mode")
                .and_then(Value::as_str)
                .filter(|mode| matches!(*mode, "host" | "sandbox"))
                .unwrap_or("sandbox")
                .into();
            settings.network_access = value
                .get("networkAccess")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            settings.writable_roots = value
                .get("writableRoots")
                .and_then(Value::as_array)
                .map(|roots| {
                    roots
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
        }
        Ok(Self {
            sandbox,
            sandbox_backend,
            sandbox_detail,
            settings: RwLock::new(settings),
            gate: AsyncRwLock::new(()),
        })
    }

    pub(super) fn settings(&self) -> CommandExecutionSettings {
        self.settings
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    pub(super) fn backend(&self) -> ProcessSandbox {
        self.backend_for(&self.settings())
    }

    fn backend_for(&self, settings: &CommandExecutionSettings) -> ProcessSandbox {
        if settings.mode == "host" {
            return ProcessSandbox::Direct;
        }
        match &self.sandbox {
            ProcessSandbox::Bubblewrap(executable)
            | ProcessSandbox::BubblewrapWithAccess { executable, .. } => {
                ProcessSandbox::BubblewrapWithAccess {
                    executable: executable.clone(),
                    network: settings.network_access,
                    writable_roots: settings.writable_roots.iter().map(PathBuf::from).collect(),
                }
            }
            sandbox => sandbox.clone(),
        }
    }

    pub(super) fn status(&self) -> CommandExecutionStatus {
        let settings = self.settings();
        let shell = if cfg!(windows) { "powershell" } else { "bash" }.to_owned();
        let shell_error = native_shell_path().err().map(|error| error.message);
        let sandbox_available = self.sandbox.is_available();
        let available = shell_error.is_none() && (settings.mode == "host" || sandbox_available);
        let detail = if let Some(error) = shell_error {
            format!("终端不可用：{error}")
        } else if settings.mode == "host" {
            "本机执行：使用当前系统账户权限，命令不受工作区或网络沙箱限制；审批策略独立生效。"
                .into()
        } else if sandbox_available {
            format!(
                "沙箱执行（{}）；网络{}；额外可写目录 {} 个。",
                self.sandbox_backend,
                if settings.network_access {
                    "允许"
                } else {
                    "由隔离器限制"
                },
                settings.writable_roots.len()
            )
        } else {
            self.sandbox_detail.clone()
        };
        CommandExecutionStatus {
            settings,
            available,
            sandbox_available,
            sandbox_backend: self.sandbox_backend.clone(),
            shell,
            detail,
        }
    }
}

impl WorkspaceService {
    pub fn verified_process_sandbox(&self) -> ProcessSandbox {
        self.commands.sandbox.clone()
    }
    pub fn command_execution_status(&self) -> CommandExecutionStatus {
        self.commands.status()
    }

    /// Called only by the authenticated user RPC; never exposed as an agent tool.
    pub async fn set_command_execution(
        &self,
        mut settings: CommandExecutionSettings,
    ) -> Result<CommandExecutionStatus, String> {
        if !matches!(settings.mode.as_str(), "sandbox" | "host") {
            return Err("mode must be sandbox or host".into());
        }
        let _change = self
            .commands
            .gate
            .try_write()
            .map_err(|_| "命令或工具正在执行，请等待完成后再切换执行边界。".to_owned())?;
        if self.native_template.has_active_processes() {
            return Err("存在运行中的终端进程，请先终止进程再切换执行边界。".into());
        }
        if settings.writable_roots.len() > 16 {
            return Err("最多允许 16 个额外可写目录。".into());
        }
        settings.writable_roots = settings
            .writable_roots
            .iter()
            .map(|root| {
                let path = Path::new(root);
                if !path.is_absolute() {
                    return Err("额外可写目录必须为绝对路径。".to_owned());
                }
                canonical_directory(path).map(|path| path.to_string_lossy().into_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        settings.writable_roots.sort();
        settings.writable_roots.dedup();
        if settings.mode == "sandbox"
            && (settings.network_access || !settings.writable_roots.is_empty())
            && self.commands.sandbox_backend != "bubblewrap"
        {
            return Err(
                "网络及额外可写目录设置目前仅支持 bubblewrap；外部隔离器由自身配置控制。".into(),
            );
        }
        if settings.mode == "sandbox" && self.commands.sandbox.is_available() {
            probe_process_sandbox(&self.commands.backend_for(&settings), &self.current_root())
                .await
                .map_err(|error| error.message)?;
        }
        self.store
            .set_config(CONFIG_KEY, settings.value())
            .await
            .map_err(|error| error.to_string())?;
        *self
            .commands
            .settings
            .write()
            .unwrap_or_else(|value| value.into_inner()) = settings;
        Ok(self.command_execution_status())
    }
}

pub(super) fn is_command(name: &str) -> bool {
    matches!(name, "bash" | "powershell" | "write_stdin")
}

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_core::{ToolCallContext, event_channel};
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    fn host() -> CommandExecutionSettings {
        CommandExecutionSettings {
            mode: "host".into(),
            ..Default::default()
        }
    }

    fn shell(service: &WorkspaceService) -> Arc<dyn Tool> {
        let name = if cfg!(windows) { "powershell" } else { "bash" };
        service
            .native_tool(ToolDefinition::direct(name, "terminal"))
            .expect("tool")
    }

    fn call(command: &str) -> ToolCall {
        ToolCall {
            id: "command-test".into(),
            name: if cfg!(windows) { "powershell" } else { "bash" }.into(),
            arguments: json!({"command":command,"yield_time_ms":1000}),
        }
    }

    fn context(tool: &dyn Tool, call: &ToolCall) -> ToolCallContext {
        let request = tool.permission_request(&call.arguments);
        let (events, _receiver) = event_channel(8);
        ToolCallContext { events, cancellation: CancellationToken::new(), session_id: None,
            metadata: request.map(|request| json!({"authorizedCapability":request.permission,"authorizedResource":request.patterns.first()})).unwrap_or_else(|| json!({})),
        }
    }

    #[tokio::test]
    async fn default_fails_closed_and_host_execution_persists_per_store() {
        let root = TempDir::new().unwrap();
        let store = Store::in_memory().await.unwrap();
        let service =
            WorkspaceService::initialize(store.clone(), root.path(), ProcessSandbox::Disabled)
                .await
                .unwrap();
        let tool = shell(&service);
        let command = call("echo eden-host-execution");
        assert!(!service.command_execution_status().available);
        assert!(tool.permission_request(&command.arguments).is_none());
        let unapproved = context(tool.as_ref(), &command);
        assert_eq!(
            tool.execute(&command, unapproved.clone())
                .await
                .unwrap_err()
                .info
                .code,
            "command_execution_unavailable"
        );
        service.set_command_execution(host()).await.unwrap();
        assert_eq!(
            tool.execute(&command, unapproved)
                .await
                .unwrap_err()
                .info
                .code,
            "command_policy_changed"
        );
        let request = tool.permission_request(&command.arguments).unwrap();
        assert_eq!(request.permission, "shell.host.execute");
        let result = tool
            .execute(&command, context(tool.as_ref(), &command))
            .await
            .unwrap();
        assert!(result.success);
        assert!(result.content.iter().any(|block| matches!(block, ContentBlock::Text { text } if text.contains("eden-host-execution"))));
        let reopened =
            WorkspaceService::initialize(store.clone(), root.path(), ProcessSandbox::Disabled)
                .await
                .unwrap();
        assert_eq!(reopened.command_execution_status().settings.mode, "host");
        let other_store = Store::in_memory().await.unwrap();
        let other =
            WorkspaceService::initialize(other_store, root.path(), ProcessSandbox::Disabled)
                .await
                .unwrap();
        assert_eq!(other.command_execution_status().settings.mode, "sandbox");
    }

    #[tokio::test]
    async fn changed_policy_rejects_stale_authorization_and_invalid_roots_do_not_commit() {
        let root = TempDir::new().unwrap();
        let store = Store::in_memory().await.unwrap();
        let service =
            WorkspaceService::initialize(store.clone(), root.path(), ProcessSandbox::Disabled)
                .await
                .unwrap();
        service.set_command_execution(host()).await.unwrap();
        let tool = shell(&service);
        let command = call("echo must-not-run");
        let stale = context(tool.as_ref(), &command);
        let mut settings = host();
        settings.writable_roots = vec![root.path().to_string_lossy().into_owned()];
        service.set_command_execution(settings).await.unwrap();
        assert_eq!(
            tool.execute(&command, stale).await.unwrap_err().info.code,
            "command_policy_changed"
        );
        let persisted = store.get_config(CONFIG_KEY).await.unwrap();
        let mut invalid = host();
        invalid.writable_roots = vec!["relative-path".into()];
        assert!(service.set_command_execution(invalid).await.is_err());
        assert_eq!(store.get_config(CONFIG_KEY).await.unwrap(), persisted);
        service
            .set_command_execution(CommandExecutionSettings::default())
            .await
            .unwrap();
        assert!(!service.command_execution_status().available);
    }

    #[tokio::test]
    async fn active_process_blocks_boundary_changes_and_can_be_terminated() {
        let root = TempDir::new().unwrap();
        let store = Store::in_memory().await.unwrap();
        let service = WorkspaceService::initialize(store, root.path(), ProcessSandbox::Disabled)
            .await
            .unwrap();
        service.set_command_execution(host()).await.unwrap();
        let tool = shell(&service);
        let command = call(if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        });
        let result = tool
            .execute(&command, context(tool.as_ref(), &command))
            .await
            .unwrap();
        assert!(
            service
                .set_command_execution(CommandExecutionSettings::default())
                .await
                .is_err()
        );
        let session_id = result.details["session_id"].clone();
        let stdin = service
            .native_tool(ToolDefinition::direct("write_stdin", "poll"))
            .unwrap();
        let stop = ToolCall {
            id: "stop".into(),
            name: "write_stdin".into(),
            arguments: json!({"session_id":session_id,"terminate":true,"yield_time_ms":1000}),
        };
        let _ = stdin.execute(&stop, context(stdin.as_ref(), &stop)).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while service.native_template.has_active_processes() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        service
            .set_command_execution(CommandExecutionSettings::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn missing_external_sandbox_does_not_enable_commands_or_extensions() {
        let root = TempDir::new().unwrap();
        let store = Store::in_memory().await.unwrap();
        let service = WorkspaceService::initialize(
            store,
            root.path(),
            ProcessSandbox::External(root.path().join("missing-wrapper")),
        )
        .await
        .unwrap();
        assert!(!service.verified_process_sandbox().is_available());
        assert!(
            service
                .command_execution_status()
                .detail
                .contains("探测失败")
        );
        service.set_command_execution(host()).await.unwrap();
        assert!(service.command_execution_status().available);
        assert!(!service.verified_process_sandbox().is_available());
    }
}
