//! Typed client protocol for the MonAgent local server.

use mon_agent_domain::{
    AgentId, BlobId, OperationId, PermissionRequestId, QuestionRequestId, SessionId, TurnId,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const JSON_RPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: u32 = 2;
pub const WEBSOCKET_PROTOCOL: &str = "mon-agent-rpc-v2";
pub const TOKEN_PROTOCOL_PREFIX: &str = "mon-agent-token.";

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    #[must_use]
    pub fn success(id: Value, result: impl Serialize) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id,
            result: Some(serde_json::to_value(result).expect("RPC result must serialize")),
            error: None,
        }
    }

    #[must_use]
    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

impl RpcNotification {
    #[must_use]
    pub fn new(method: impl Into<String>, params: impl Serialize) -> Self {
        Self {
            jsonrpc: JSON_RPC_VERSION.to_owned(),
            method: method.into(),
            params: serde_json::to_value(params).expect("RPC notification must serialize"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client_name: String,
    pub client_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub server_name: String,
    pub server_version: String,
    pub agent_core_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadyNotification {
    pub connection_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEnvironmentLocation {
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub district: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEnvironment {
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub locale: String,
    #[serde(default)]
    pub location: SessionEnvironmentLocation,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub participants: Vec<SessionParticipant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<SessionEnvironment>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipant {
    pub assistant_id: Value,
    #[serde(default)]
    pub assistant_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_id: Option<Value>,
    #[serde(default)]
    pub character_name: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub standing_image_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_config_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_config_id: Option<i64>,
    #[serde(default)]
    pub position: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipantsParams {
    pub session_id: SessionId,
    pub participants: Vec<SessionParticipant>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleParams {
    pub session_id: SessionId,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompactParams {
    pub session_id: SessionId,
    #[serde(default)]
    pub instructions: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionListParams {
    #[serde(default = "default_session_limit")]
    pub limit: u32,
    #[serde(default)]
    pub include_closed: bool,
}

fn default_session_limit() -> u32 {
    50
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Closed,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: SessionId,
    pub title: String,
    pub title_source: String,
    pub status: SessionStatus,
    #[serde(default)]
    pub participants: Vec<SessionParticipant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<SessionEnvironment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_breakdown: Option<TokenBreakdown>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub character: u64,
    pub skills: u64,
    pub system: u64,
    pub tools: u64,
    pub history: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_miss: u64,
    #[serde(default)]
    pub cache_hit_rate: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_output: Option<u64>,
    #[serde(default)]
    pub provider_adjustment: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_measurement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_fingerprint: Option<String>,
    #[serde(default)]
    pub prompt_cache_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_cache_invalidation_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokenizer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokenizer_model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub session_id: SessionId,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<SessionEnvironment>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnQueueParams {
    pub session_id: SessionId,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnQueueResult {
    pub session_id: SessionId,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<OperationId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub blob_id: BlobId,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BlobInfo {
    pub id: BlobId,
    pub sha256: String,
    pub mime: String,
    pub byte_length: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogParams {
    pub core_base_url: String,
    pub core_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelectParams {
    pub core_base_url: String,
    pub core_token: String,
    pub ai_entity_id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelInfo {
    pub id: String,
    pub provider: String,
    pub api: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_entity_id: Option<Value>,
    pub label: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelIdentityInfo {
    pub id: Value,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelOptionInfo {
    pub id: String,
    pub ai_entity_id: Value,
    pub label: String,
    pub name: String,
    pub provider: String,
    pub provider_name: String,
    pub provider_icon: String,
    pub supported_models: Vec<String>,
    #[serde(rename = "modelID")]
    pub model_id: String,
    pub status: String,
    pub is_multimodal: bool,
    pub is_choice_default: bool,
    pub is_vision_default: bool,
    pub context_window: u64,
    pub selected: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogInfo {
    pub source: String,
    pub service_type: String,
    pub vendors: Value,
    pub assistant: RuntimeModelIdentityInfo,
    pub character: RuntimeModelIdentityInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<RuntimeModelOptionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision: Option<RuntimeModelOptionInfo>,
    pub selection_source: String,
    pub options: Vec<RuntimeModelOptionInfo>,
    #[serde(default)]
    pub actors: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillReadParams {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub model_invocable: bool,
    pub enabled: bool,
    pub available: bool,
    pub missing_tools: Vec<String>,
    pub scope: String,
    pub source_type: String,
    pub tools: Vec<String>,
    pub profiles: Vec<String>,
    pub permissions: Vec<String>,
    pub default_prompt: String,
    pub content_hash: String,
    pub total_bytes: u64,
    pub files: Vec<String>,
    pub manifest: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallParams {
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillEnableParams {
    pub name: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillInspectParams {
    pub source_type: String,
    pub source_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_subpath: Option<String>,
    pub scope: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreviewInstallParams {
    pub preview_id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreviewSource {
    #[serde(rename = "type")]
    pub source_type: String,
    pub uri: String,
    #[serde(rename = "ref")]
    pub source_ref: String,
    pub subpath: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreviewInfo {
    #[serde(rename = "previewID")]
    pub preview_id: String,
    pub skill_name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub scope: String,
    pub source: SkillPreviewSource,
    pub tools: Vec<String>,
    pub profiles: Vec<String>,
    pub model_invocable: bool,
    pub content_hash: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentListParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentReadParams {
    pub agent_id: AgentId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageParams {
    pub agent_id: AgentId,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadInfo {
    pub id: AgentId,
    pub session_id: SessionId,
    pub parent_id: Option<AgentId>,
    pub agent_path: String,
    pub task_name: String,
    pub role: String,
    pub status: AgentThreadStatus,
    pub result: Option<AgentThreadResultInfo>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub config: Value,
    pub usage: Value,
    pub deadline_at: Option<i64>,
    pub coordination_batch_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentThreadStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadResultInfo {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<Value>,
    #[serde(default)]
    pub changed_files: Vec<String>,
    #[serde(default)]
    pub tests: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnAccepted {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub input_id: OperationId,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EventListParams {
    pub session_id: SessionId,
    #[serde(default)]
    pub after_seq: i64,
    #[serde(default = "default_event_limit")]
    pub limit: u32,
}

fn default_event_limit() -> u32 {
    200
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageListParams {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default = "default_message_limit")]
    pub limit: u32,
}

fn default_message_limit() -> u32 {
    50
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub session_id: SessionId,
    pub seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub event_type: String,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub items: Vec<SessionEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Once,
    Always,
    Deny,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResolveParams {
    pub request_id: PermissionRequestId,
    pub decision: PermissionDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestInfo {
    pub id: PermissionRequestId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub operation_id: OperationId,
    pub capability: String,
    pub resource: String,
    pub state: String,
    pub request: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default = "default_session_limit")]
    pub limit: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum OperationDecision {
    Retry,
    Abandon,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationResolveParams {
    pub operation_id: OperationId,
    pub decision: OperationDecision,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OperationInfo {
    pub operation_id: OperationId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub tool_call_id: String,
    pub tool_name: String,
    pub capability: String,
    pub resource: String,
    pub state: String,
    pub request: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResolveParams {
    pub request_id: QuestionRequestId,
    pub answers: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRejectParams {
    pub request_id: QuestionRequestId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOptionInfo {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItemInfo {
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOptionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestInfo {
    pub id: QuestionRequestId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub state: String,
    pub questions: Vec<QuestionItemInfo>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoListParams {
    #[serde(default = "default_session_limit")]
    pub limit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoCreateParams {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_memo_kind")]
    pub kind: String,
    #[serde(default = "default_memo_status")]
    pub status: String,
    #[serde(default = "default_memo_priority")]
    pub priority: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub repeat_rule: String,
    #[serde(default)]
    pub related_session_id: String,
    #[serde(default)]
    pub metadata: Value,
}

fn default_memo_kind() -> String {
    "note".to_owned()
}
fn default_memo_status() -> String {
    "active".to_owned()
}
fn default_memo_priority() -> String {
    "normal".to_owned()
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoUpdateParams {
    pub id: i64,
    #[serde(default)]
    pub patch: Value,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoIdParams {
    pub id: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoInfo {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub status: String,
    pub priority: String,
    pub remind_at: Option<i64>,
    pub due_at: Option<i64>,
    pub repeat_rule: String,
    pub related_session_id: String,
    pub last_triggered_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub metadata: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCreateParams {
    pub connector_key: String,
    pub identity_key: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_disconnected")]
    pub desired_state: String,
    #[serde(default)]
    pub settings: Value,
}
fn default_disconnected() -> String {
    "disconnected".to_owned()
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorUpdateParams {
    pub id: String,
    #[serde(default)]
    pub patch: Value,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInfo {
    pub id: String,
    pub connector_key: String,
    pub identity_key: String,
    pub display_name: String,
    pub desired_state: String,
    pub runtime_state: String,
    pub settings: Value,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ConnectorCapabilityInvocation {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ConnectorCapabilityInfo {
    pub id: String,
    pub kind: String,
    pub direction: String,
    pub label: String,
    pub description: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation: Option<ConnectorCapabilityInvocation>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct ConnectorCatalogEntry {
    pub key: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub version: String,
    pub revision: String,
    pub hot_reload: bool,
    pub worker_isolated: bool,
    pub settings_schema: Value,
    pub capabilities: Vec<ConnectorCapabilityInfo>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCatalogError {
    pub key: String,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCatalogInfo {
    pub connectors: Vec<ConnectorCatalogEntry>,
    pub errors: Vec<ConnectorCatalogError>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaResolveParams {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaRequestInfo {
    pub id: String,
    pub session_id: SessionId,
    pub kind: String,
    pub state: String,
    pub request: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSwitchParams {
    pub session_id: SessionId,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSwitchResult {
    pub current_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathParams {
    #[serde(default)]
    pub path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    Directory,
    File,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryInfo {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: WorkspaceEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryInfo {
    pub root: String,
    pub path: String,
    pub entries: Vec<WorkspaceEntryInfo>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub content: String,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutionModeInfo {
    Sequential,
    Parallel,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ToolExposureInfo {
    Direct,
    Deferred,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub label: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    pub source: String,
    pub version: String,
    pub namespace: String,
    pub execution_mode: ToolExecutionModeInfo,
    pub exposure: ToolExposureInfo,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakeListParams {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

fn default_page() -> u32 {
    1
}

fn default_page_size() -> u32 {
    20
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakeDiaryInfo {
    pub id: String,
    pub run_id: String,
    pub session_id: SessionId,
    pub assistant_id: String,
    pub character_id: String,
    pub title: String,
    pub content: String,
    pub mood: String,
    pub metadata: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakeRunInfo {
    pub id: String,
    pub job_id: String,
    pub session_id: SessionId,
    pub schema_version: String,
    pub event_id: String,
    pub status: String,
    pub request: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<Value>,
    pub author_snapshot: Value,
    pub attempts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub diaries: Vec<SelfAwakeDiaryInfo>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SelfAwakePage {
    pub count: u64,
    pub page: u32,
    pub page_size: u32,
    pub total_pages: u32,
    pub results: Vec<SelfAwakeRunInfo>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectorListParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectorBeatInfo {
    #[serde(rename = "assistantID")]
    pub assistant_id: Value,
    pub intent: String,
    pub speech_act: String,
    pub address_to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_beat: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectorSceneInfo {
    pub domain: String,
    pub interaction_type: String,
    pub confidence: f64,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectorExecutionInfo {
    pub mode: String,
    #[serde(
        rename = "leadAssistantID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub lead_assistant_id: Option<Value>,
    #[serde(
        rename = "toolOwnerAssistantID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_owner_assistant_id: Option<Value>,
    pub observation_strategy: String,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DirectorRunStatus {
    Planned,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectorRunInfo {
    #[serde(rename = "planID")]
    pub plan_id: String,
    #[serde(
        rename = "userMessageID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub user_message_id: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<DirectorSceneInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<DirectorExecutionInfo>,
    pub beats: Vec<DirectorBeatInfo>,
    pub status: DirectorRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_beat_index: Option<u32>,
    pub completed_beat_indexes: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participant_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceTtsSynthesizeParams {
    pub session_id: SessionId,
    pub message_id: String,
    pub segment_group_id: String,
    pub group_index: u32,
    pub sequence: u32,
    pub text: String,
    pub config_id: i64,
    pub mode: VoiceTtsMode,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum VoiceTtsMode {
    TextOnly,
    All,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct VoiceTtsSynthesizeResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_blob_id: Option<BlobId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speech_segment_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceSpeechSegmentListParams {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub struct VoiceSpeechSegmentInfo {
    pub id: i64,
    pub external_message_id: String,
    pub audio_asset_id: i64,
    pub audio_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_blob_id: Option<BlobId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub audio_format: String,
    pub segment_group_id: String,
    pub group_index: u32,
    pub sequence: u32,
    pub text_hash: String,
    pub text_length: u32,
}

/// Schema catalog used by generators. RPC transport fields are defined by
/// [`RpcRequest`]; these fields make every method payload reachable to JSON Schema.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSchemaCatalog {
    pub rpc_request: RpcRequest,
    pub rpc_response: RpcResponse,
    pub initialize: InitializeParams,
    pub session_create: SessionCreateParams,
    pub session_participants: SessionParticipantsParams,
    pub session_read: SessionReadParams,
    pub session_title: SessionTitleParams,
    pub session_list: SessionListParams,
    pub session_compact: SessionCompactParams,
    pub turn_start: TurnStartParams,
    pub turn_queue: TurnQueueParams,
    pub model_catalog: ModelCatalogParams,
    pub model_select: ModelSelectParams,
    pub model_read: ModelReadParams,
    pub event_list: EventListParams,
    pub message_list: MessageListParams,
    pub permission_list: PermissionListParams,
    pub permission_resolve: PermissionResolveParams,
    pub operation_list: OperationListParams,
    pub operation_resolve: OperationResolveParams,
    pub question_list: QuestionListParams,
    pub question_resolve: QuestionResolveParams,
    pub question_reject: QuestionRejectParams,
    pub skill_list: SkillListParams,
    pub skill_read: SkillReadParams,
    pub skill_install: SkillInstallParams,
    pub skill_enable: SkillEnableParams,
    pub skill_inspect: SkillInspectParams,
    pub skill_preview_install: SkillPreviewInstallParams,
    pub agent_list: AgentListParams,
    pub agent_read: AgentReadParams,
    pub agent_message: AgentMessageParams,
    pub memo_list: MemoListParams,
    pub memo_create: MemoCreateParams,
    pub memo_update: MemoUpdateParams,
    pub memo_id: MemoIdParams,
    pub connector_create: ConnectorCreateParams,
    pub connector_update: ConnectorUpdateParams,
    pub connector_catalog: ConnectorCatalogInfo,
    pub media_list: MediaListParams,
    pub media_resolve: MediaResolveParams,
    pub workspace_switch: WorkspaceSwitchParams,
    pub workspace_path: WorkspacePathParams,
    pub workspace_directory: WorkspaceDirectoryInfo,
    pub workspace_file: WorkspaceFileInfo,
    pub tool_info: ToolInfo,
    pub self_awake_list: SelfAwakeListParams,
    pub director_list: DirectorListParams,
    pub voice_tts_synthesize: VoiceTtsSynthesizeParams,
    pub voice_speech_segment_list: VoiceSpeechSegmentListParams,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn success_response_has_exactly_one_outcome() {
        let response = RpcResponse::success(json!(7), json!({"ready": true}));
        let value = serde_json::to_value(response).expect("serialize response");
        assert_eq!(value["jsonrpc"], JSON_RPC_VERSION);
        assert_eq!(value["result"]["ready"], true);
        assert!(value.get("error").is_none());
    }

    #[test]
    fn request_schema_is_generated_from_rust_type() {
        let schema = schemars::schema_for!(RpcRequest);
        let encoded = serde_json::to_value(schema).expect("serialize schema");
        assert_eq!(encoded["title"], "RpcRequest");
    }
}
