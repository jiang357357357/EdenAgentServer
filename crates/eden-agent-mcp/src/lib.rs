//! Sandboxed MCP client runtimes exposed as reloadable Eden Agent tools.

use async_trait::async_trait;
use eden_agent_core::{
    DynamicToolSource, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use eden_agent_tools::{ProcessSandbox, sandboxed_program_command};
use rmcp::{
    RoleClient, ServiceExt,
    model::CallToolRequestParams,
    service::RunningService,
    transport::{StreamableHttpClientTransport, TokioChildProcess},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::Mutex;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpRuntimeKind {
    Stdio,
    Http,
}

#[derive(Clone, Debug)]
pub struct McpComponentConfig {
    pub plugin_id: String,
    pub component_id: String,
    pub kind: McpRuntimeKind,
    pub plugin_root: PathBuf,
    pub descriptor_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StdioDescriptor {
    #[serde(default = "schema_one")]
    schema_version: u32,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpDescriptor {
    #[serde(default = "schema_one")]
    schema_version: u32,
    url: String,
}

const fn schema_one() -> u32 {
    1
}

#[derive(Clone)]
pub struct McpManager {
    inner: Arc<Inner>,
}

struct Inner {
    sandbox: ProcessSandbox,
    workspace_root: PathBuf,
    plugins: RwLock<BTreeMap<String, Vec<Arc<McpRuntime>>>>,
    tools: RwLock<BTreeMap<String, Arc<McpTool>>>,
}

struct McpRuntime {
    plugin_id: String,
    component_id: String,
    service: Mutex<RunningService<RoleClient, ()>>,
}

struct McpTool {
    definition: ToolDefinition,
    remote_name: String,
    runtime: Arc<McpRuntime>,
}

impl McpManager {
    #[must_use]
    pub fn new(sandbox: ProcessSandbox, workspace_root: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                sandbox,
                workspace_root,
                plugins: RwLock::new(BTreeMap::new()),
                tools: RwLock::new(BTreeMap::new()),
            }),
        }
    }

    pub async fn set_plugin_components(
        &self,
        plugin_id: &str,
        components: Vec<McpComponentConfig>,
    ) -> Result<bool, String> {
        if plugin_id.trim().is_empty() {
            return Err("plugin ID cannot be empty".to_owned());
        }
        let mut runtimes = Vec::new();
        let mut tools = Vec::new();
        for component in components {
            if component.plugin_id != plugin_id {
                return Err("MCP component owner does not match plugin ID".to_owned());
            }
            let (runtime, discovered) = self.connect(component).await?;
            tools.extend(discovered);
            runtimes.push(runtime);
        }
        let old_names = self
            .inner
            .tools
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .filter(|tool| tool.runtime.plugin_id == plugin_id)
            .map(|tool| tool.definition.name.clone())
            .collect::<HashSet<_>>();
        let incoming = tools
            .iter()
            .map(|tool| tool.definition.name.clone())
            .collect::<HashSet<_>>();
        if incoming.len() != tools.len() {
            return Err(format!("duplicate MCP tool name in plugin {plugin_id}"));
        }
        {
            let catalog = self
                .inner
                .tools
                .read()
                .unwrap_or_else(|value| value.into_inner());
            if let Some(name) = incoming
                .iter()
                .find(|name| catalog.contains_key(*name) && !old_names.contains(*name))
            {
                return Err(format!(
                    "MCP tool name collides with another plugin: {name}"
                ));
            }
        }
        let old_runtimes = self
            .inner
            .plugins
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(plugin_id.to_owned(), runtimes)
            .unwrap_or_default();
        {
            let mut catalog = self
                .inner
                .tools
                .write()
                .unwrap_or_else(|value| value.into_inner());
            for name in &old_names {
                catalog.remove(name);
            }
            for tool in tools {
                catalog.insert(tool.definition.name.clone(), Arc::new(tool));
            }
        }
        cancel_runtimes(old_runtimes);
        Ok(old_names != incoming)
    }

    pub fn remove_plugin_components(&self, plugin_id: &str) -> bool {
        let runtimes = self
            .inner
            .plugins
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .remove(plugin_id);
        let Some(runtimes) = runtimes else {
            return false;
        };
        self.inner
            .tools
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .retain(|_, tool| tool.runtime.plugin_id != plugin_id);
        cancel_runtimes(runtimes);
        true
    }

    async fn connect(
        &self,
        component: McpComponentConfig,
    ) -> Result<(Arc<McpRuntime>, Vec<McpTool>), String> {
        let descriptor = std::fs::read(&component.descriptor_path)
            .map_err(|error| format!("read MCP descriptor: {error}"))?;
        let service = match component.kind {
            McpRuntimeKind::Stdio => {
                if !self.inner.sandbox.is_available() {
                    return Err(
                        "MCP stdio is disabled because no OS sandbox is configured".to_owned()
                    );
                }
                let descriptor: StdioDescriptor = serde_json::from_slice(&descriptor)
                    .map_err(|error| format!("invalid MCP stdio descriptor: {error}"))?;
                if descriptor.schema_version != 1 || descriptor.command.trim().is_empty() {
                    return Err("invalid MCP stdio descriptor schema or command".to_owned());
                }
                let cwd = confined_cwd(
                    &component.plugin_root,
                    descriptor.cwd.as_deref().unwrap_or("."),
                )?;
                let command = sandboxed_program_command(
                    &self.inner.sandbox,
                    &self.inner.workspace_root,
                    &cwd,
                    "mcp",
                    Path::new(&descriptor.command),
                    &descriptor.args,
                )
                .map_err(|error| error.to_string())?;
                let transport = TokioChildProcess::new(tokio::process::Command::from(command))
                    .map_err(|error| format!("launch MCP stdio server: {error}"))?;
                tokio::time::timeout(CONNECT_TIMEOUT, ().serve(transport))
                    .await
                    .map_err(|_| "MCP stdio initialization timed out".to_owned())?
                    .map_err(|error| format!("initialize MCP stdio server: {error}"))?
            }
            McpRuntimeKind::Http => {
                let descriptor: HttpDescriptor = serde_json::from_slice(&descriptor)
                    .map_err(|error| format!("invalid MCP HTTP descriptor: {error}"))?;
                if descriptor.schema_version != 1 {
                    return Err("invalid MCP HTTP descriptor schema".to_owned());
                }
                validate_mcp_http_url(&descriptor.url)?;
                let transport = StreamableHttpClientTransport::from_uri(descriptor.url);
                tokio::time::timeout(CONNECT_TIMEOUT, ().serve(transport))
                    .await
                    .map_err(|_| "MCP HTTP initialization timed out".to_owned())?
                    .map_err(|error| format!("initialize MCP HTTP server: {error}"))?
            }
        };
        let remote_tools = tokio::time::timeout(CONNECT_TIMEOUT, service.list_all_tools())
            .await
            .map_err(|_| "MCP tools/list timed out".to_owned())?
            .map_err(|error| format!("list MCP tools: {error}"))?;
        let runtime = Arc::new(McpRuntime {
            plugin_id: component.plugin_id.clone(),
            component_id: component.component_id.clone(),
            service: Mutex::new(service),
        });
        let mut names = HashSet::new();
        let tools = remote_tools
            .into_iter()
            .map(|tool| {
                let remote_name = tool.name.into_owned();
                let name = format!(
                    "mcp__{}__{}__{}",
                    tool_segment(&component.plugin_id),
                    tool_segment(&component.component_id),
                    tool_segment(&remote_name)
                );
                if !names.insert(name.clone()) {
                    return Err(format!(
                        "duplicate MCP tool after name normalization: {name}"
                    ));
                }
                let mut definition = ToolDefinition::direct(
                    name,
                    tool.description
                        .map(|value| value.into_owned())
                        .unwrap_or_else(|| format!("MCP tool {remote_name}")),
                );
                definition.label = tool.title.unwrap_or_else(|| remote_name.clone());
                definition.parameters = Value::Object((*tool.input_schema).clone());
                definition.output_schema = tool
                    .output_schema
                    .map(|schema| Value::Object((*schema).clone()));
                definition.source = "plugin".to_owned();
                definition.namespace =
                    format!("mcp.{}.{}", component.plugin_id, component.component_id);
                Ok(McpTool {
                    definition,
                    remote_name,
                    runtime: runtime.clone(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok((runtime, tools))
    }
}

impl DynamicToolSource for McpManager {
    fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner
            .tools
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .get(name)
            .cloned()
            .map(|tool| tool as Arc<dyn Tool>)
    }

    fn direct_definitions(&self) -> Vec<ToolDefinition> {
        self.inner
            .tools
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .map(|tool| tool.definition.clone())
            .collect()
    }
}

#[async_trait]
impl Tool for McpTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    fn timeout(&self) -> Option<Duration> {
        Some(CALL_TIMEOUT)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let arguments = match &call.arguments {
            Value::Object(arguments) => arguments.clone(),
            _ => {
                return Err(ToolFailure::new(
                    "mcp_invalid_arguments",
                    "MCP tool arguments must be an object",
                ));
            }
        };
        let params = CallToolRequestParams::new(self.remote_name.clone()).with_arguments(arguments);
        let service = self.runtime.service.lock().await;
        let response = tokio::select! {
            _ = context.cancellation.cancelled() => {
                return Err(ToolFailure::new("mcp_cancelled", "MCP tool call was cancelled"));
            }
            result = tokio::time::timeout(CALL_TIMEOUT, service.call_tool(params)) => {
                result
                    .map_err(|_| ToolFailure::new("mcp_timeout", "MCP tool call timed out"))?
                    .map_err(|error| ToolFailure::new("mcp_call_failed", error.to_string()))?
            }
        };
        let details = serde_json::to_value(&response).unwrap_or_else(|_| json!({}));
        if response.is_error.unwrap_or(false) {
            return Err(
                ToolFailure::new("mcp_tool_error", "MCP tool returned an error")
                    .with_details(details),
            );
        }
        Ok(ToolOutput {
            content: vec![eden_agent_core::ContentBlock::Text {
                text: response
                    .structured_content
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|| details.to_string()),
            }],
            details,
            structured_content: response.structured_content,
            external_context: Vec::new(),
            terminate: false,
            success: true,
        })
    }
}

fn confined_cwd(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("MCP cwd escapes plugin package: {relative:?}"));
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize plugin root: {error}"))?;
    let cwd = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("canonicalize MCP cwd: {error}"))?;
    cwd.starts_with(&root)
        .then_some(cwd)
        .ok_or_else(|| "MCP cwd escapes plugin package".to_owned())
}

fn validate_mcp_http_url(value: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(value).map_err(|error| format!("invalid MCP HTTP URL: {error}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("MCP HTTP URL cannot contain credentials or a fragment".to_owned());
    }
    let host = parsed
        .host()
        .ok_or_else(|| "MCP HTTP URL must include a host".to_owned())?;
    let loopback = match host {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err("MCP HTTP URL must use HTTPS or loopback HTTP".to_owned()),
    }
}

fn tool_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            output.push(character.to_ascii_lowercase());
        } else if !output.ends_with('_') {
            output.push('_');
        }
    }
    output.trim_matches('_').to_owned()
}

fn cancel_runtimes(runtimes: Vec<Arc<McpRuntime>>) {
    for runtime in runtimes {
        tracing::debug!(plugin_id = %runtime.plugin_id, component_id = %runtime.component_id, "stopping MCP runtime");
        if let Ok(service) = runtime.service.try_lock() {
            service.cancellation_token().cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_cwd_are_confined() {
        assert_eq!(tool_segment("GitHub/search-code"), "github_search_code");
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join("server")).expect("server");
        assert_eq!(
            confined_cwd(root.path(), "server").expect("cwd"),
            root.path()
                .join("server")
                .canonicalize()
                .expect("canonical")
        );
        assert!(confined_cwd(root.path(), "../escape").is_err());
    }

    #[test]
    fn descriptors_reject_unknown_fields() {
        assert!(
            serde_json::from_value::<StdioDescriptor>(json!({
                "command":"server","unexpected":true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<HttpDescriptor>(json!({"url":"https://example.test/mcp"}))
                .is_ok()
        );
    }

    #[test]
    fn http_urls_reject_userinfo_prefix_tricks_and_non_loopback_plaintext() {
        for valid in [
            "https://example.test/mcp",
            "http://localhost:4318/mcp",
            "http://127.0.0.1:4318/mcp",
            "http://[::1]:4318/mcp",
        ] {
            validate_mcp_http_url(valid).expect(valid);
        }
        for invalid in [
            "http://localhost:4318@evil.test/mcp",
            "http://127.0.0.1.evil.test:4318/mcp",
            "http://192.168.1.20:4318/mcp",
            "https://user:secret@example.test/mcp",
            "https://example.test/mcp#fragment",
        ] {
            assert!(validate_mcp_http_url(invalid).is_err(), "{invalid}");
        }
    }
}
