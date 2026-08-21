//! Permission policy and durable approval broker.

use async_trait::async_trait;
use globset::{Glob, GlobMatcher};
use mon_agent_core::{
    AfterToolCall, AfterToolCallResult, BeforeToolCall, BeforeToolCallResult, ToolFailure,
    ToolHooks, ToolOutput,
};
use mon_agent_domain::{OperationId, PermissionRequestId, SessionId, TurnId};
use mon_agent_store::{PermissionRecord, Store, StoreError};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};
use thiserror::Error;
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyEffect {
    Allow,
    Ask,
    Deny,
}

#[derive(Clone, Debug)]
pub struct PermissionRule {
    pub effect: PolicyEffect,
    capability: GlobMatcher,
    resource: GlobMatcher,
}

impl PermissionRule {
    pub fn new(
        effect: PolicyEffect,
        capability: impl Into<String>,
        resource: impl Into<String>,
    ) -> Result<Self, PolicyError> {
        let capability_pattern = capability.into();
        let resource_pattern = resource.into();
        Ok(Self {
            effect,
            capability: Glob::new(&capability_pattern)?.compile_matcher(),
            resource: Glob::new(&resource_pattern)?.compile_matcher(),
        })
    }

    fn matches(&self, capability: &str, resource: &str) -> bool {
        self.capability.is_match(capability) && self.resource.is_match(resource)
    }
}

#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("invalid permission glob: {0}")]
    InvalidGlob(#[from] globset::Error),
}

#[derive(Clone, Debug)]
pub struct PermissionPolicy {
    default: PolicyEffect,
    rules: Vec<PermissionRule>,
}

impl PermissionPolicy {
    #[must_use]
    pub fn new(default: PolicyEffect) -> Self {
        Self {
            default,
            rules: Vec::new(),
        }
    }

    pub fn push(&mut self, rule: PermissionRule) {
        self.rules.push(rule);
    }

    #[must_use]
    pub fn evaluate(&self, capability: &str, resource: &str) -> PolicyEffect {
        self.rules
            .iter()
            .rev()
            .find(|rule| rule.matches(capability, resource))
            .map_or(self.default, |rule| rule.effect)
    }
}

impl Default for PermissionPolicy {
    fn default() -> Self {
        Self::new(PolicyEffect::Ask)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApprovalDecision {
    Once,
    Always,
    Deny,
}

impl ApprovalDecision {
    fn name(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Deny => "deny",
        }
    }
}

#[derive(Debug, Error)]
pub enum ApprovalError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("permission request is no longer waiting: {0}")]
    NotWaiting(PermissionRequestId),
    #[error(transparent)]
    Policy(#[from] PolicyError),
}

#[derive(Clone)]
pub struct ApprovalService {
    store: Store,
    policy: Arc<RwLock<PermissionPolicy>>,
    pending: Arc<Mutex<HashMap<PermissionRequestId, oneshot::Sender<ApprovalDecision>>>>,
    mode: Arc<RwLock<PermissionMode>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PermissionMode {
    Restricted,
    FullAccess,
    Takeover,
}

impl PermissionMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "restricted" => Some(Self::Restricted),
            "full_access" => Some(Self::FullAccess),
            "takeover" => Some(Self::Takeover),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::FullAccess => "full_access",
            Self::Takeover => "takeover",
        }
    }
}

impl ApprovalService {
    #[must_use]
    pub fn new(store: Store, policy: PermissionPolicy) -> Self {
        Self {
            store,
            policy: Arc::new(RwLock::new(policy)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            mode: Arc::new(RwLock::new(PermissionMode::Restricted)),
        }
    }

    pub fn mode(&self) -> PermissionMode {
        *self
            .mode
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub async fn set_mode(&self, mode: PermissionMode) -> Result<(), ApprovalError> {
        self.store
            .set_config("permission.mode", json!(mode.as_str()))
            .await?;
        *self
            .mode
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
        Ok(())
    }

    pub fn hydrate_mode(&self, mode: PermissionMode) {
        *self
            .mode
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
    }

    pub async fn list_pending(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<Vec<PermissionRecord>, ApprovalError> {
        Ok(self.store.list_pending_permissions(session_id).await?)
    }

    pub async fn resolve(
        &self,
        request_id: PermissionRequestId,
        decision: ApprovalDecision,
        message: Option<String>,
    ) -> Result<PermissionRecord, ApprovalError> {
        let mutation = self
            .store
            .resolve_permission(
                request_id,
                decision.name(),
                json!({"decision": decision.name(), "message": message}),
            )
            .await?;
        if decision == ApprovalDecision::Always {
            let rule = PermissionRule::new(
                PolicyEffect::Allow,
                mutation.permission.capability.clone(),
                mutation.permission.resource.clone(),
            )?;
            self.policy
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(rule);
        }
        if let Some(waiter) = self.pending.lock().await.remove(&request_id) {
            let _ = waiter.send(decision);
        }
        Ok(mutation.permission)
    }

    fn evaluate(&self, capability: &str, resource: &str) -> PolicyEffect {
        match self.mode() {
            PermissionMode::Takeover => return PolicyEffect::Allow,
            PermissionMode::FullAccess if !capability.starts_with("shell.") => {
                return PolicyEffect::Allow;
            }
            PermissionMode::Restricted | PermissionMode::FullAccess => {}
        }
        self.policy
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .evaluate(capability, resource)
    }
}

#[async_trait]
impl ToolHooks for ApprovalService {
    async fn before(
        &self,
        context: BeforeToolCall,
        cancellation: CancellationToken,
    ) -> Result<BeforeToolCallResult, ToolFailure> {
        let session_id = metadata_id::<SessionId>(&context.context.metadata, "sessionId")?;
        let turn_id = metadata_id::<TurnId>(&context.context.metadata, "turnId")?;
        let operation_id = stable_operation_id(session_id, turn_id, &context.call.id);
        let capability = context
            .permission_request
            .as_ref()
            .map(|request| request.permission.as_str())
            .unwrap_or("tool.execute");
        let resource = context
            .permission_request
            .as_ref()
            .and_then(|request| request.patterns.first().cloned())
            .unwrap_or_else(|| context.definition.name.clone());
        let existing = self
            .store
            .plan_operation(
                operation_id,
                session_id,
                turn_id,
                &context.call.id,
                &context.definition.name,
                capability,
                &resource,
                json!({
                    "tool":context.definition.name,
                    "arguments":redact(&context.call.arguments),
                    "permission":context.permission_request,
                }),
            )
            .await
            .map_err(|error| ToolFailure::new("operation_store_failed", error.to_string()))?;
        tracing::debug!(
            %session_id,
            %turn_id,
            %operation_id,
            tool_call_id = %context.call.id,
            tool_name = %context.definition.name,
            state = %existing.state,
            "durable tool operation planned"
        );
        if existing.state == "committed" {
            let output = existing
                .result
                .and_then(|value| serde_json::from_value::<ToolOutput>(value).ok())
                .ok_or_else(|| {
                    ToolFailure::new(
                        "operation_result_missing",
                        "committed operation has no reusable result",
                    )
                })?;
            tracing::info!(
                %session_id,
                %turn_id,
                %operation_id,
                tool_call_id = %context.call.id,
                tool_name = %context.definition.name,
                "reused committed tool operation result"
            );
            return Ok(BeforeToolCallResult {
                cached_output: Some(output),
                metadata: json!({"operationId":operation_id,"operationReused":true}),
            });
        }
        if matches!(existing.state.as_str(), "started" | "unknown") {
            tracing::warn!(
                %session_id,
                %turn_id,
                %operation_id,
                tool_call_id = %context.call.id,
                tool_name = %context.definition.name,
                "tool operation outcome is unknown; user review required"
            );
            if existing.state == "started" {
                let _ = self
                    .store
                    .transition_operation(
                        operation_id,
                        "unknown",
                        None,
                        Some(json!({"code":"outcome_unknown"})),
                    )
                    .await;
            }
            let _ = self
                .store
                .append_event(
                    session_id,
                    Some(turn_id),
                    "operation.review_required",
                    json!({
                        "operationId":operation_id,
                        "toolCallId":context.call.id,
                        "toolName":context.definition.name,
                        "state":"unknown",
                        "allowedDecisions":["retry","abandon"],
                    }),
                )
                .await;
            return Err(ToolFailure::new(
                "operation_outcome_unknown",
                format!(
                    "operation {operation_id} may already have produced an external side effect; user review is required"
                ),
            )
            .with_details(json!({"operationId":operation_id,"state":"unknown"})));
        }
        if existing.state == "failed"
            && existing
                .error
                .as_ref()
                .and_then(|value| value.get("decision"))
                .and_then(Value::as_str)
                == Some("abandon")
        {
            return Err(ToolFailure::new(
                "operation_abandoned",
                format!("operation {operation_id} was abandoned by the user"),
            ));
        }

        let Some(request) = context.permission_request else {
            self.mark_operation_started(operation_id).await?;
            return Ok(BeforeToolCallResult {
                cached_output: None,
                metadata: json!({"operationId":operation_id}),
            });
        };
        match self.evaluate(&request.permission, &resource) {
            PolicyEffect::Allow => {
                self.mark_operation_started(operation_id).await?;
                return Ok(BeforeToolCallResult {
                    cached_output: None,
                    metadata: json!({"operationId":operation_id}),
                });
            }
            PolicyEffect::Deny => {
                let _ = self
                    .store
                    .transition_operation(
                        operation_id,
                        "failed",
                        None,
                        Some(json!({"code":"permission_denied"})),
                    )
                    .await;
                return Err(ToolFailure::new(
                    "permission_denied",
                    format!("permission denied for {} on {resource}", request.permission),
                ));
            }
            PolicyEffect::Ask => {}
        }

        let request_id = PermissionRequestId::new();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id, sender);
        let created = self
            .store
            .create_permission(
                request_id,
                session_id,
                turn_id,
                operation_id,
                &request.permission,
                &resource,
                json!({
                    "tool": context.definition.name,
                    "arguments": redact(&context.call.arguments),
                    "patterns": request.patterns,
                    "always": request.always,
                }),
            )
            .await;
        if let Err(error) = created {
            self.pending.lock().await.remove(&request_id);
            return Err(ToolFailure::new(
                "permission_store_failed",
                error.to_string(),
            ));
        }
        tracing::info!(
            %session_id,
            %turn_id,
            %operation_id,
            %request_id,
            tool_call_id = %context.call.id,
            tool_name = %context.definition.name,
            capability = %request.permission,
            "tool permission decision requested"
        );

        let decision = tokio::select! {
            _ = cancellation.cancelled() => {
                self.pending.lock().await.remove(&request_id);
                let _ = self.store.resolve_permission(
                    request_id,
                    "deny",
                    json!({"decision": "deny", "reason": "cancelled"}),
                ).await;
                let _ = self.store.transition_operation(
                    operation_id,
                    "failed",
                    None,
                    Some(json!({"code":"aborted"})),
                ).await;
                return Err(ToolFailure::new("aborted", "permission request cancelled"));
            }
            decision = receiver => decision.map_err(|_| {
                ToolFailure::new("permission_unavailable", "permission request was abandoned")
            })?,
        };
        match decision {
            ApprovalDecision::Once | ApprovalDecision::Always => {
                self.mark_operation_started(operation_id).await?;
                Ok(BeforeToolCallResult {
                    cached_output: None,
                    metadata: json!({"operationId":operation_id}),
                })
            }
            ApprovalDecision::Deny => {
                let _ = self
                    .store
                    .transition_operation(
                        operation_id,
                        "failed",
                        None,
                        Some(json!({"code":"permission_denied"})),
                    )
                    .await;
                Err(ToolFailure::new(
                    "permission_denied",
                    format!("permission denied for {} on {resource}", request.permission),
                ))
            }
        }
    }

    async fn after(
        &self,
        context: AfterToolCall,
        _cancellation: CancellationToken,
    ) -> Result<AfterToolCallResult, ToolFailure> {
        let session_id = metadata_id::<SessionId>(&context.context.metadata, "sessionId")?;
        let turn_id = metadata_id::<TurnId>(&context.context.metadata, "turnId")?;
        let operation_id = metadata_id::<OperationId>(&context.context.metadata, "operationId")?;
        let result = serde_json::to_value(&context.output)
            .map_err(|error| ToolFailure::new("operation_encode_failed", error.to_string()))?;
        self.store
            .transition_operation(
                operation_id,
                if context.is_error {
                    "failed"
                } else {
                    "committed"
                },
                (!context.is_error).then_some(result),
                context.error.as_ref().map(|error| json!(error)),
            )
            .await
            .map_err(|error| ToolFailure::new("operation_store_failed", error.to_string()))?;
        tracing::info!(
            %session_id,
            %turn_id,
            %operation_id,
            state = if context.is_error { "failed" } else { "committed" },
            "durable tool operation finalized"
        );
        Ok(AfterToolCallResult {
            output: context.output,
            is_error: context.is_error,
            error: context.error,
        })
    }
}

impl ApprovalService {
    async fn mark_operation_started(&self, operation_id: OperationId) -> Result<(), ToolFailure> {
        self.store
            .transition_operation(operation_id, "authorized", None, None)
            .await
            .map_err(|error| ToolFailure::new("operation_store_failed", error.to_string()))?;
        self.store
            .transition_operation(operation_id, "started", None, None)
            .await
            .map_err(|error| ToolFailure::new("operation_store_failed", error.to_string()))?;
        Ok(())
    }
}

fn stable_operation_id(session_id: SessionId, turn_id: TurnId, tool_call_id: &str) -> OperationId {
    let mut digest = Sha256::new();
    digest.update(session_id.to_string().as_bytes());
    digest.update([0]);
    digest.update(turn_id.to_string().as_bytes());
    digest.update([0]);
    digest.update(tool_call_id.as_bytes());
    let hash = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    OperationId::from_uuid(uuid::Uuid::from_bytes(bytes))
}

fn redact(value: &Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    let value = if ["token", "password", "secret", "apikey", "api_key"]
                        .iter()
                        .any(|candidate| lower.contains(candidate))
                    {
                        Value::String("[REDACTED]".to_owned())
                    } else {
                        redact(value)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact).collect()),
        value => value.clone(),
    }
}

fn metadata_id<T>(metadata: &Value, key: &str) -> Result<T, ToolFailure>
where
    T: std::str::FromStr,
{
    metadata
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolFailure::new("permission_context_missing", format!("missing {key}")))?
        .parse()
        .map_err(|_| ToolFailure::new("permission_context_invalid", format!("invalid {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_core::{
        AgentContext, AssistantMessage, PermissionRequest, ToolCall, ToolDefinition,
    };

    #[test]
    fn last_matching_policy_rule_wins() {
        let mut policy = PermissionPolicy::new(PolicyEffect::Ask);
        policy.push(PermissionRule::new(PolicyEffect::Deny, "workspace.*", "*").expect("rule"));
        policy.push(
            PermissionRule::new(PolicyEffect::Allow, "workspace.write", "docs/**").expect("rule"),
        );
        assert_eq!(
            policy.evaluate("workspace.write", "docs/plan.md"),
            PolicyEffect::Allow
        );
        assert_eq!(
            policy.evaluate("workspace.write", "src/main.rs"),
            PolicyEffect::Deny
        );
        assert_eq!(
            policy.evaluate("shell.execute", "cargo test"),
            PolicyEffect::Ask
        );
    }

    #[tokio::test]
    async fn permission_modes_persist_and_keep_shell_guarded_in_full_access() {
        let store = Store::in_memory().await.expect("store");
        let service = ApprovalService::new(store.clone(), PermissionPolicy::default());
        service
            .set_mode(PermissionMode::FullAccess)
            .await
            .expect("persist mode");
        assert_eq!(
            service.evaluate("workspace.write", "README.md"),
            PolicyEffect::Allow
        );
        assert_eq!(
            service.evaluate("shell.execute", "cargo test"),
            PolicyEffect::Ask
        );
        assert_eq!(
            store.get_config("permission.mode").await.expect("config"),
            Some(json!("full_access"))
        );
        service
            .set_mode(PermissionMode::Takeover)
            .await
            .expect("takeover");
        assert_eq!(
            service.evaluate("shell.execute", "cargo test"),
            PolicyEffect::Allow
        );
    }

    #[tokio::test]
    async fn approval_is_durable_before_tool_is_released() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("approval").await.expect("session");
        let turn_id = TurnId::new();
        let service = ApprovalService::new(store.clone(), PermissionPolicy::default());
        let waiting_service = service.clone();
        let task = tokio::spawn(async move {
            waiting_service
                .before(
                    BeforeToolCall {
                        assistant_message: AssistantMessage::text(""),
                        call: ToolCall {
                            id: "call_1".to_owned(),
                            name: "write".to_owned(),
                            arguments: json!({"path": "README.md"}),
                        },
                        definition: ToolDefinition::direct("write", "write file"),
                        permission_request: Some(PermissionRequest {
                            permission: "workspace.write".to_owned(),
                            patterns: vec!["README.md".to_owned()],
                            always: vec!["README.md".to_owned()],
                        }),
                        context: AgentContext {
                            metadata: json!({"sessionId": session.id, "turnId": turn_id}),
                            ..AgentContext::default()
                        },
                    },
                    CancellationToken::new(),
                )
                .await
        });

        let request = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(request) = service
                    .list_pending(Some(session.id))
                    .await
                    .expect("pending")
                    .into_iter()
                    .next()
                {
                    break request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("permission request timeout");
        service
            .resolve(request.id, ApprovalDecision::Once, None)
            .await
            .expect("resolve");
        task.await.expect("join").expect("tool released");
        let events = store.list_events(session.id, 0).await.expect("events");
        assert_eq!(events[0].event_type, "permission.requested");
        assert_eq!(events[1].event_type, "permission.resolved");
    }

    #[tokio::test]
    async fn committed_operation_is_reused_without_reexecution() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("journal").await.expect("session");
        let turn_id = TurnId::new();
        let service = ApprovalService::new(store.clone(), PermissionPolicy::default());
        let make_context = || BeforeToolCall {
            assistant_message: AssistantMessage::text(""),
            call: ToolCall {
                id: "call_stable".to_owned(),
                name: "read_state".to_owned(),
                arguments: json!({"apiToken":"must-not-persist","query":"status"}),
            },
            definition: ToolDefinition::direct("read_state", "read state"),
            permission_request: None,
            context: AgentContext {
                metadata: json!({"sessionId":session.id,"turnId":turn_id}),
                ..AgentContext::default()
            },
        };
        let before = service
            .before(make_context(), CancellationToken::new())
            .await
            .expect("before");
        assert!(before.cached_output.is_none());
        let operation_id = before.metadata["operationId"]
            .as_str()
            .expect("operation id")
            .parse::<OperationId>()
            .expect("valid operation id");
        let planned = store.get_operation(operation_id).await.expect("operation");
        assert_eq!(planned.state, "started");
        assert_eq!(planned.request["arguments"]["apiToken"], "[REDACTED]");

        let mut committed_metadata = make_context().context.metadata;
        committed_metadata
            .as_object_mut()
            .expect("metadata object")
            .extend(
                before
                    .metadata
                    .as_object()
                    .expect("before metadata object")
                    .clone(),
            );
        service
            .after(
                AfterToolCall {
                    assistant_message: AssistantMessage::text(""),
                    call: make_context().call,
                    output: ToolOutput::text("stable result"),
                    is_error: false,
                    error: None,
                    context: AgentContext {
                        metadata: committed_metadata,
                        ..AgentContext::default()
                    },
                },
                CancellationToken::new(),
            )
            .await
            .expect("commit");
        assert_eq!(
            store
                .get_operation(operation_id)
                .await
                .expect("committed")
                .state,
            "committed"
        );
        let replay = service
            .before(make_context(), CancellationToken::new())
            .await
            .expect("replay");
        assert_eq!(
            replay.cached_output.expect("cached").content,
            ToolOutput::text("stable result").content
        );
    }
}
