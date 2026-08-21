//! Durable workspace switching and permission-gated external read-only tools.

use async_trait::async_trait;
use mon_agent_core::{
    ContentBlock, PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition,
    ToolExecutionMode, ToolFailure, ToolOutput,
};
use mon_agent_domain::SessionId;
use mon_agent_store::{Store, WorkspaceStateRecord};
use mon_agent_tools::{NativeToolConfig, ProcessSandbox, create_native_tool};
use regex::RegexBuilder;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

const MAX_LIST_ENTRIES: usize = 500;
const MAX_FIND_RESULTS: usize = 500;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_GREP_FILES: usize = 500;
const MAX_GREP_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GREP_MATCHES: usize = 500;

#[derive(Clone)]
pub struct WorkspaceService {
    store: Store,
    root: Arc<RwLock<PathBuf>>,
    native_template: NativeToolConfig,
}

impl WorkspaceService {
    pub async fn initialize(
        store: Store,
        configured_root: impl AsRef<Path>,
        process_sandbox: ProcessSandbox,
    ) -> Result<Self, String> {
        let configured = canonical_directory(configured_root.as_ref())?;
        let configured_text = configured.to_string_lossy().into_owned();
        let persisted = store
            .initialize_workspace_state(&configured_text)
            .await
            .map_err(|error| error.to_string())?;
        let root = canonical_directory(Path::new(&persisted.current_path))
            .unwrap_or_else(|_| configured.clone());
        if root.to_string_lossy() != persisted.current_path {
            store
                .set_workspace_current(&root.to_string_lossy())
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(Self {
            store,
            root: Arc::new(RwLock::new(root.clone())),
            native_template: NativeToolConfig::new(root).with_process_sandbox(process_sandbox),
        })
    }

    #[must_use]
    pub fn current_root(&self) -> PathBuf {
        self.root
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    pub async fn state(&self) -> Result<WorkspaceStateRecord, String> {
        self.store
            .workspace_state()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn runtime_is_idle(&self) -> Result<bool, String> {
        let store_idle = self
            .store
            .workspace_runtime_is_idle()
            .await
            .map_err(|error| error.to_string())?;
        Ok(store_idle && !self.native_template.has_active_processes())
    }

    pub async fn request_switch(
        &self,
        session_id: SessionId,
        path: impl AsRef<Path>,
    ) -> Result<WorkspaceStateRecord, String> {
        let target = canonical_directory(path.as_ref())?;
        self.store
            .request_workspace_switch(session_id, &target.to_string_lossy())
            .await
            .map_err(|error| error.to_string())
    }

    /// Publish a pre-validated pending root. The in-memory root changes before
    /// the durable event is broadcast, and rolls back if the transaction fails.
    pub async fn commit_pending(&self, path: &Path) -> Result<WorkspaceStateRecord, String> {
        let target = canonical_directory(path)?;
        let previous = {
            let mut root = self.root.write().unwrap_or_else(|value| value.into_inner());
            std::mem::replace(&mut *root, target.clone())
        };
        match self
            .store
            .complete_workspace_switch(&target.to_string_lossy())
            .await
        {
            Ok(state) => Ok(state),
            Err(error) => {
                *self.root.write().unwrap_or_else(|value| value.into_inner()) = previous;
                Err(error.to_string())
            }
        }
    }

    pub async fn fail_pending(&self, path: &Path, error: &str) -> Result<(), String> {
        self.store
            .fail_workspace_switch(&path.to_string_lossy(), error)
            .await
            .map(|_| ())
            .map_err(|store_error| store_error.to_string())
    }

    #[must_use]
    pub fn native_tool(&self, definition: ToolDefinition) -> Option<Arc<dyn Tool>> {
        create_native_tool(
            definition.clone(),
            self.native_template
                .clone()
                .with_workspace_root(self.current_root()),
        )?;
        Some(Arc::new(DynamicNativeTool {
            definition,
            root: Arc::clone(&self.root),
            template: self.native_template.clone(),
        }))
    }

    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut tools: Vec<Arc<dyn Tool>> = vec![Arc::new(SwitchWorkspaceTool(self.clone()))];
        tools.extend(
            ExternalAction::ALL
                .into_iter()
                .map(|action| Arc::new(ExternalReadTool { action }) as Arc<dyn Tool>),
        );
        tools
    }
}

struct DynamicNativeTool {
    definition: ToolDefinition,
    root: Arc<RwLock<PathBuf>>,
    template: NativeToolConfig,
}

impl DynamicNativeTool {
    fn implementation(&self) -> Arc<dyn Tool> {
        let root = self
            .root
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        create_native_tool(
            self.definition.clone(),
            self.template.clone().with_workspace_root(root),
        )
        .expect("dynamic wrapper only accepts native tool definitions")
    }
}

#[async_trait]
impl Tool for DynamicNativeTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        self.implementation().permission_request(arguments)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        self.implementation().execute(call, context).await
    }
}

struct SwitchWorkspaceTool(WorkspaceService);

#[async_trait]
impl Tool for SwitchWorkspaceTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "switch_workspace",
            "Request an authorized workspace switch that is applied after all agent work is idle",
        );
        definition.parameters = json!({
            "type":"object","required":["path"],
            "properties":{"path":{"type":"string"}},"additionalProperties":false
        });
        definition.execution_mode = ToolExecutionMode::Sequential;
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        Some(PermissionRequest {
            permission: "workspace.switch".to_owned(),
            patterns: vec![
                arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ],
            always: Vec::new(),
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        if context
            .metadata
            .get("agentPath")
            .and_then(Value::as_str)
            .unwrap_or("/root")
            != "/root"
        {
            return Err(ToolFailure::new(
                "root_only",
                "only the root agent may request a workspace switch",
            ));
        }
        let session_id = context
            .session_id
            .as_deref()
            .ok_or_else(|| {
                ToolFailure::new("missing_session", "workspace switch requires a session")
            })?
            .parse::<SessionId>()
            .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))?;
        let path = call
            .arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolFailure::new("invalid_path", "path must be a directory"))?;
        let state = self
            .0
            .request_switch(session_id, path)
            .await
            .map_err(|error| ToolFailure::new("workspace_switch_failed", error))?;
        let details = serde_json::to_value(&state).unwrap_or_else(|_| json!({"status":"pending"}));
        Ok(structured_output(
            format!(
                "Workspace switch is authorized and pending: {}. It will apply after current agent work is idle.",
                state.pending_path.as_deref().unwrap_or(path)
            ),
            details,
        ))
    }
}

#[derive(Clone, Copy)]
enum ExternalAction {
    List,
    Read,
    Find,
    Grep,
}

impl ExternalAction {
    const ALL: [Self; 4] = [Self::List, Self::Read, Self::Find, Self::Grep];

    fn name(self) -> &'static str {
        match self {
            Self::List => "external_ls",
            Self::Read => "external_read",
            Self::Find => "external_find",
            Self::Grep => "external_grep",
        }
    }
}

struct ExternalReadTool {
    action: ExternalAction,
}

#[async_trait]
impl Tool for ExternalReadTool {
    fn definition(&self) -> ToolDefinition {
        let (description, properties, required) = match self.action {
            ExternalAction::List => (
                "List an explicitly authorized external directory without following symbolic links",
                json!({"root":{"type":"string"},"path":{"type":"string"}}),
                json!(["root"]),
            ),
            ExternalAction::Read => (
                "Read one small text file under an explicitly authorized external root",
                json!({"root":{"type":"string"},"path":{"type":"string"}}),
                json!(["root", "path"]),
            ),
            ExternalAction::Find => (
                "Find bounded file or directory names under an explicitly authorized external root",
                json!({"root":{"type":"string"},"path":{"type":"string"},"name":{"type":"string"},"max_depth":{"type":"integer","minimum":1,"maximum":8}}),
                json!(["root", "name"]),
            ),
            ExternalAction::Grep => (
                "Search bounded text files under an explicitly authorized external root",
                json!({"root":{"type":"string"},"path":{"type":"string"},"pattern":{"type":"string"},"ignore_case":{"type":"boolean"},"max_depth":{"type":"integer","minimum":1,"maximum":8}}),
                json!(["root", "pattern"]),
            ),
        };
        let mut definition = ToolDefinition::direct(self.action.name(), description);
        definition.parameters = json!({
            "type":"object","properties":properties,"required":required,"additionalProperties":false
        });
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        let root = arguments.get("root").and_then(Value::as_str).unwrap_or("");
        let path = arguments.get("path").and_then(Value::as_str).unwrap_or(".");
        Some(PermissionRequest {
            permission: "filesystem.read_external".to_owned(),
            patterns: vec![format!("{root}::{path}")],
            always: Vec::new(),
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let action = self.action;
        let arguments = call.arguments.clone();
        let cancellation = context.cancellation.clone();
        tokio::task::spawn_blocking(move || execute_external(action, &arguments, &cancellation))
            .await
            .map_err(|error| ToolFailure::new("external_read_failed", error.to_string()))?
    }
}

fn execute_external(
    action: ExternalAction,
    arguments: &Value,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ToolOutput, ToolFailure> {
    let root = arguments
        .get("root")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_root", "root must be a directory"))?;
    let root = canonical_directory(Path::new(root))
        .map_err(|error| ToolFailure::new("invalid_root", error))?;
    let target = scoped_target(
        &root,
        arguments.get("path").and_then(Value::as_str).unwrap_or("."),
    )?;
    if cancellation.is_cancelled() {
        return Err(ToolFailure::new("cancelled", "external read was cancelled"));
    }
    match action {
        ExternalAction::List => external_list(&root, &target),
        ExternalAction::Read => external_read(&root, &target),
        ExternalAction::Find => external_find(&root, &target, arguments, cancellation),
        ExternalAction::Grep => external_grep(&root, &target, arguments, cancellation),
    }
}

fn external_list(root: &Path, target: &Path) -> Result<ToolOutput, ToolFailure> {
    if !target.is_dir() {
        return Err(ToolFailure::new(
            "not_directory",
            "external_ls target is not a directory",
        ));
    }
    let mut entries = fs::read_dir(target)
        .map_err(io_failure)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_failure)?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    let truncated = entries.len() > MAX_LIST_ENTRIES;
    let entries = entries
        .into_iter()
        .take(MAX_LIST_ENTRIES)
        .map(|entry| {
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_failure)?;
            Ok(json!({
                "name":entry.file_name().to_string_lossy(),
                "type":if metadata.file_type().is_symlink(){"symlink"}else if metadata.is_dir(){"directory"}else{"file"}
            }))
        })
        .collect::<Result<Vec<_>, ToolFailure>>()?;
    let text = entries
        .iter()
        .map(|entry| {
            format!(
                "{}: {}",
                entry["type"].as_str().unwrap_or("file"),
                entry["name"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(structured_output(
        if text.is_empty() {
            "Directory is empty".to_owned()
        } else {
            text
        },
        json!({"root":root,"path":display_path(root,target),"entries":entries,"truncated":truncated}),
    ))
}

fn external_read(root: &Path, target: &Path) -> Result<ToolOutput, ToolFailure> {
    let metadata = fs::symlink_metadata(target).map_err(io_failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ToolFailure::new(
            "not_file",
            "external_read target must be a regular file",
        ));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(ToolFailure::new(
            "file_too_large",
            "external_read file exceeds 256 KiB",
        ));
    }
    let bytes = fs::read(target).map_err(io_failure)?;
    if bytes.contains(&0) {
        return Err(ToolFailure::new(
            "binary_file",
            "external_read only supports text files",
        ));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(structured_output(
        text,
        json!({"root":root,"path":display_path(root,target),"bytes":bytes.len()}),
    ))
}

fn external_find(
    root: &Path,
    target: &Path,
    arguments: &Value,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ToolOutput, ToolFailure> {
    if !target.is_dir() {
        return Err(ToolFailure::new(
            "not_directory",
            "external_find target is not a directory",
        ));
    }
    let needle = arguments
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_name", "name cannot be empty"))?
        .to_lowercase();
    let depth = bounded_depth(arguments);
    let mut matches = Vec::new();
    walk(root, target, depth, cancellation, |path, metadata| {
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.to_lowercase().contains(&needle))
        {
            matches.push(json!({
                "path":display_path(root,path),
                "type":if metadata.is_dir(){"directory"}else{"file"}
            }));
        }
        matches.len() < MAX_FIND_RESULTS
    })?;
    let text = matches
        .iter()
        .map(|entry| {
            format!(
                "{}: {}",
                entry["type"].as_str().unwrap_or("file"),
                entry["path"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(structured_output(
        if text.is_empty() {
            "No matching entries".to_owned()
        } else {
            text
        },
        json!({"root":root,"matches":matches,"truncated":matches.len()>=MAX_FIND_RESULTS}),
    ))
}

fn external_grep(
    root: &Path,
    target: &Path,
    arguments: &Value,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<ToolOutput, ToolFailure> {
    let pattern = arguments
        .get("pattern")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_pattern", "pattern cannot be empty"))?;
    let matcher = RegexBuilder::new(pattern)
        .case_insensitive(
            arguments
                .get("ignore_case")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        )
        .build()
        .map_err(|error| ToolFailure::new("invalid_pattern", error.to_string()))?;
    let depth = bounded_depth(arguments);
    let mut files_scanned = 0_usize;
    let mut bytes_scanned = 0_u64;
    let mut matches = Vec::new();
    let mut inspect = |path: &Path, metadata: &fs::Metadata| -> bool {
        if !metadata.is_file()
            || metadata.len() > MAX_READ_BYTES
            || files_scanned >= MAX_GREP_FILES
            || bytes_scanned.saturating_add(metadata.len()) > MAX_GREP_BYTES
        {
            return true;
        }
        let Ok(bytes) = fs::read(path) else {
            return true;
        };
        files_scanned += 1;
        bytes_scanned = bytes_scanned.saturating_add(bytes.len() as u64);
        if bytes.contains(&0) {
            return true;
        }
        for (line, text) in String::from_utf8_lossy(&bytes).lines().enumerate() {
            if matcher.is_match(text) {
                matches.push(json!({
                    "path":display_path(root,path),"line":line+1,
                    "text":text.chars().take(500).collect::<String>()
                }));
                if matches.len() >= MAX_GREP_MATCHES {
                    return false;
                }
            }
        }
        files_scanned < MAX_GREP_FILES && bytes_scanned < MAX_GREP_BYTES
    };
    if target.is_file() {
        let metadata = fs::symlink_metadata(target).map_err(io_failure)?;
        inspect(target, &metadata);
    } else if target.is_dir() {
        walk(root, target, depth, cancellation, &mut inspect)?;
    } else {
        return Err(ToolFailure::new(
            "not_found",
            "external_grep target does not exist",
        ));
    }
    let text = matches
        .iter()
        .map(|entry| {
            format!(
                "{}:{}: {}",
                entry["path"].as_str().unwrap_or(""),
                entry["line"],
                entry["text"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(structured_output(
        if text.is_empty() {
            "No matching text".to_owned()
        } else {
            text
        },
        json!({
            "root":root,"matches":matches,"filesScanned":files_scanned,
            "bytesScanned":bytes_scanned,"truncated":matches.len()>=MAX_GREP_MATCHES
        }),
    ))
}

fn walk<F>(
    root: &Path,
    start: &Path,
    max_depth: usize,
    cancellation: &tokio_util::sync::CancellationToken,
    mut visitor: F,
) -> Result<(), ToolFailure>
where
    F: FnMut(&Path, &fs::Metadata) -> bool,
{
    let mut queue = VecDeque::from([(start.to_owned(), 0_usize)]);
    while let Some((directory, depth)) = queue.pop_front() {
        if cancellation.is_cancelled() {
            return Err(ToolFailure::new(
                "cancelled",
                "external traversal was cancelled",
            ));
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(io_failure)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_failure)?;
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_failure)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            let canonical = canonicalize_path(&path).map_err(io_failure)?;
            if !canonical.starts_with(root) {
                continue;
            }
            if !visitor(&canonical, &metadata) {
                return Ok(());
            }
            if metadata.is_dir() && depth < max_depth {
                queue.push_back((canonical, depth + 1));
            }
        }
    }
    Ok(())
}

fn scoped_target(root: &Path, raw: &str) -> Result<PathBuf, ToolFailure> {
    let raw = raw.trim();
    let requested = PathBuf::from(raw);
    if requested
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ToolFailure::new(
            "external_scope_violation",
            "parent-directory traversal is not allowed in an external read path",
        ));
    }
    let candidate = if raw.is_empty() || raw == "." {
        root.to_owned()
    } else if requested.is_absolute() {
        if !requested.starts_with(root) {
            return Err(ToolFailure::new(
                "external_scope_violation",
                "absolute path is outside the explicitly authorized external root",
            ));
        }
        requested
    } else {
        root.join(requested)
    };
    reject_symlink_components(root, &candidate)?;
    let target = canonicalize_path(&candidate).map_err(io_failure)?;
    if !target.starts_with(root) {
        return Err(ToolFailure::new(
            "external_scope_violation",
            "path escapes the explicitly authorized external root",
        ));
    }
    Ok(target)
}

fn reject_symlink_components(root: &Path, candidate: &Path) -> Result<(), ToolFailure> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        ToolFailure::new(
            "external_scope_violation",
            "path is outside the explicitly authorized external root",
        )
    })?;
    let mut current = root.to_owned();
    for component in relative.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(io_failure)?;
        if metadata.file_type().is_symlink() {
            return Err(ToolFailure::new(
                "external_symlink_rejected",
                "symbolic links are not followed by external read tools",
            ));
        }
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let path = canonicalize_path(path).map_err(|error| {
        format!(
            "workspace directory does not exist: {} ({error})",
            path.display()
        )
    })?;
    if !path.is_dir() {
        return Err(format!(
            "workspace target is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn canonicalize_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(canonical)
}

fn bounded_depth(arguments: &Value) -> usize {
    arguments
        .get("max_depth")
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .clamp(1, 8) as usize
}

fn display_path(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/")
}

fn io_failure(error: std::io::Error) -> ToolFailure {
    ToolFailure::new("external_io_failed", error.to_string())
}

fn structured_output(text: String, details: Value) -> ToolOutput {
    ToolOutput {
        content: vec![ContentBlock::Text { text }],
        structured_content: Some(details.clone()),
        details,
        ..ToolOutput::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_core::event_channel;
    use std::io::Write;
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    fn context(session_id: SessionId, agent_path: &str) -> ToolCallContext {
        let (events, _receiver) = event_channel(8);
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: Some(session_id.to_string()),
            metadata: json!({"agentPath":agent_path}),
        }
    }

    #[tokio::test]
    async fn switch_is_root_only_durable_and_changes_native_tool_root_after_commit() {
        let first = TempDir::new().expect("first");
        let second = TempDir::new().expect("second");
        fs::write(first.path().join("first.txt"), "one").expect("first file");
        fs::write(second.path().join("second.txt"), "two").expect("second file");
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("workspace").await.expect("session");
        let service =
            WorkspaceService::initialize(store.clone(), first.path(), ProcessSandbox::Disabled)
                .await
                .expect("service");
        let switch = SwitchWorkspaceTool(service.clone());
        let call = ToolCall {
            id: "switch".to_owned(),
            name: "switch_workspace".to_owned(),
            arguments: json!({"path":second.path()}),
        };
        assert!(
            switch
                .execute(&call, context(session.id, "/root/child"))
                .await
                .expect_err("subagent")
                .message
                .contains("root agent")
        );
        switch
            .execute(&call, context(session.id, "/root"))
            .await
            .expect("request");
        assert_eq!(
            service.current_root(),
            canonicalize_path(first.path()).expect("first root")
        );
        service.commit_pending(second.path()).await.expect("commit");
        assert_eq!(
            service.current_root(),
            canonicalize_path(second.path()).expect("second root")
        );
    }

    #[tokio::test]
    async fn external_reads_are_bounded_and_cannot_escape_the_approved_root() {
        let root = TempDir::new().expect("root");
        let outside = TempDir::new().expect("outside");
        fs::create_dir(root.path().join("nested")).expect("nested");
        fs::write(
            root.path().join("nested/note.txt"),
            "MonAgent evidence\nsecond line",
        )
        .expect("note");
        fs::write(outside.path().join("secret.txt"), "secret").expect("secret");
        let read = ExternalReadTool {
            action: ExternalAction::Read,
        };
        let (events, _receiver) = event_channel(8);
        let tool_context = ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: None,
            metadata: json!({}),
        };
        let output = read
            .execute(
                &ToolCall {
                    id: "read".to_owned(),
                    name: "external_read".to_owned(),
                    arguments: json!({"root":root.path(),"path":"nested/note.txt"}),
                },
                tool_context.clone(),
            )
            .await
            .expect("read");
        assert!(matches!(
            &output.content[0],
            ContentBlock::Text { text } if text.contains("evidence")
        ));
        let error = read
            .execute(
                &ToolCall {
                    id: "escape".to_owned(),
                    name: "external_read".to_owned(),
                    arguments: json!({"root":root.path(),"path":outside.path().join("secret.txt")}),
                },
                tool_context,
            )
            .await
            .expect_err("escape");
        assert_eq!(error.info.code, "external_scope_violation");
    }

    #[test]
    fn grep_and_find_skip_symlinks_and_obey_limits() {
        let root = TempDir::new().expect("root");
        let mut file = fs::File::create(root.path().join("evidence.txt")).expect("file");
        writeln!(file, "needle").expect("write");
        let output = execute_external(
            ExternalAction::Grep,
            &json!({"root":root.path(),"pattern":"needle"}),
            &CancellationToken::new(),
        )
        .expect("grep");
        assert_eq!(
            output.details["matches"].as_array().expect("matches").len(),
            1
        );
        let output = execute_external(
            ExternalAction::Find,
            &json!({"root":root.path(),"name":"evidence","max_depth":1}),
            &CancellationToken::new(),
        )
        .expect("find");
        assert_eq!(
            output.details["matches"].as_array().expect("matches").len(),
            1
        );
    }
}
