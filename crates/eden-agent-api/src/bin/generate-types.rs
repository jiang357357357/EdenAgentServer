use eden_agent_api::{
    AgentListParams, AgentMessageParams, AgentReadParams, AgentThreadInfo, AgentThreadResultInfo,
    AgentThreadStatus, AttachmentRef, BlobInfo, ConnectorCapabilityInfo,
    ConnectorCapabilityInvocation, ConnectorCatalogEntry, ConnectorCatalogError,
    ConnectorCatalogInfo, ConnectorCreateParams, ConnectorInfo, ConnectorUpdateParams,
    DirectorBeatInfo, DirectorExecutionInfo, DirectorListParams, DirectorRunInfo,
    DirectorRunStatus, DirectorSceneInfo, EventListParams, EventPage, InitializeParams,
    InitializeResult, MediaListParams, MediaRequestInfo, MediaResolveParams, MemoCreateParams,
    MemoIdParams, MemoInfo, MemoListParams, MemoUpdateParams, MessageListParams,
    ModelCatalogParams, ModelReadParams, ModelSelectParams, OperationDecision, OperationInfo,
    OperationListParams, OperationResolveParams, PermissionDecision, PermissionListParams,
    PermissionRequestInfo, PermissionResolveParams, PluginActivateParams, PluginComponentInfo,
    PluginEnableParams, PluginInfo, PluginInspectParams, PluginListParams,
    PluginMarketInspectParams, PluginMarketListParams, PluginMarketReleaseInfo,
    PluginMarketSourceAddParams, PluginMarketSourceInfo, PluginMarketSourceParams,
    PluginPermissionDecision, PluginPermissionGrantInfo, PluginPermissionInfo,
    PluginPermissionSetParams, PluginPreviewInfo, PluginPreviewInstallParams, PluginReadParams,
    PluginUiContributionInfo, PluginUninstallResult, PluginVersionInfo, QuestionItemInfo,
    QuestionListParams, QuestionOptionInfo, QuestionRejectParams, QuestionRequestInfo,
    QuestionResolveParams, ReadyNotification, RpcError, RpcNotification, RpcRequest, RpcResponse,
    RuntimeModelCatalogInfo, RuntimeModelIdentityInfo, RuntimeModelInfo, RuntimeModelOptionInfo,
    RuntimeOrigin, SelfAwakeDiaryInfo, SelfAwakeListParams, SelfAwakePage, SelfAwakeRunInfo,
    SessionCompactParams, SessionCreateParams, SessionEnvironment, SessionEnvironmentLocation,
    SessionEvent, SessionListParams, SessionParticipant, SessionParticipantsParams,
    SessionReadParams, SessionStatus, SessionSummary, SessionTitleParams, SkillEnableParams,
    SkillInfo, SkillInspectParams, SkillInstallParams, SkillListParams, SkillPreviewInfo,
    SkillPreviewInstallParams, SkillPreviewSource, SkillReadParams, TokenBreakdown,
    ToolExecutionModeInfo, ToolExposureInfo, ToolInfo, TurnAccepted, TurnQueueParams,
    TurnQueueResult, TurnStartParams, VoiceSpeechSegmentInfo, VoiceSpeechSegmentListParams,
    VoiceTtsMode, VoiceTtsSynthesizeParams, VoiceTtsSynthesizeResult, WorkspaceDirectoryInfo,
    WorkspaceEntryInfo, WorkspaceEntryKind, WorkspaceFileInfo, WorkspaceInfo, WorkspacePathParams,
    WorkspaceSwitchParams, WorkspaceSwitchResult,
};
use eden_agent_domain::{
    AgentId, BlobId, ItemId, OperationId, PermissionRequestId, QuestionRequestId, SessionId,
    ToolCallId, TurnId,
};
use std::{env, fs, path::PathBuf};
use ts_rs::TS;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = env::args().nth(1).map_or_else(
        || PathBuf::from("frontend/web/src/generated/eden-agent-rpc.ts"),
        PathBuf::from,
    );
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }

    let config = ts_rs::Config::default();
    let declarations = [
        SessionId::decl(&config),
        TurnId::decl(&config),
        ItemId::decl(&config),
        AgentId::decl(&config),
        ToolCallId::decl(&config),
        OperationId::decl(&config),
        PermissionRequestId::decl(&config),
        QuestionRequestId::decl(&config),
        BlobId::decl(&config),
        RpcRequest::decl(&config),
        RpcResponse::decl(&config),
        RpcError::decl(&config),
        RpcNotification::decl(&config),
        RuntimeOrigin::decl(&config),
        InitializeParams::decl(&config),
        InitializeResult::decl(&config),
        ReadyNotification::decl(&config),
        SessionEnvironmentLocation::decl(&config),
        SessionEnvironment::decl(&config),
        SessionCreateParams::decl(&config),
        SessionParticipant::decl(&config),
        SessionParticipantsParams::decl(&config),
        SessionReadParams::decl(&config),
        SessionTitleParams::decl(&config),
        SessionCompactParams::decl(&config),
        SessionListParams::decl(&config),
        SessionStatus::decl(&config),
        SessionSummary::decl(&config),
        TokenBreakdown::decl(&config),
        AttachmentRef::decl(&config),
        BlobInfo::decl(&config),
        ModelCatalogParams::decl(&config),
        ModelReadParams::decl(&config),
        ModelSelectParams::decl(&config),
        RuntimeModelInfo::decl(&config),
        RuntimeModelIdentityInfo::decl(&config),
        RuntimeModelOptionInfo::decl(&config),
        RuntimeModelCatalogInfo::decl(&config),
        SkillListParams::decl(&config),
        SkillReadParams::decl(&config),
        SkillInfo::decl(&config),
        SkillInstallParams::decl(&config),
        SkillEnableParams::decl(&config),
        SkillInspectParams::decl(&config),
        SkillPreviewInstallParams::decl(&config),
        SkillPreviewSource::decl(&config),
        SkillPreviewInfo::decl(&config),
        PluginListParams::decl(&config),
        PluginReadParams::decl(&config),
        PluginInspectParams::decl(&config),
        PluginPreviewInstallParams::decl(&config),
        PluginEnableParams::decl(&config),
        PluginActivateParams::decl(&config),
        PluginUninstallResult::decl(&config),
        PluginComponentInfo::decl(&config),
        PluginUiContributionInfo::decl(&config),
        PluginPermissionInfo::decl(&config),
        PluginPermissionDecision::decl(&config),
        PluginPermissionSetParams::decl(&config),
        PluginPermissionGrantInfo::decl(&config),
        PluginMarketSourceAddParams::decl(&config),
        PluginMarketSourceParams::decl(&config),
        PluginMarketListParams::decl(&config),
        PluginMarketInspectParams::decl(&config),
        PluginMarketSourceInfo::decl(&config),
        PluginMarketReleaseInfo::decl(&config),
        PluginVersionInfo::decl(&config),
        PluginInfo::decl(&config),
        PluginPreviewInfo::decl(&config),
        AgentListParams::decl(&config),
        AgentReadParams::decl(&config),
        AgentMessageParams::decl(&config),
        AgentThreadStatus::decl(&config),
        AgentThreadResultInfo::decl(&config),
        AgentThreadInfo::decl(&config),
        TurnStartParams::decl(&config),
        TurnQueueParams::decl(&config),
        TurnQueueResult::decl(&config),
        TurnAccepted::decl(&config),
        EventListParams::decl(&config),
        MessageListParams::decl(&config),
        SessionEvent::decl(&config),
        EventPage::decl(&config),
        PermissionDecision::decl(&config),
        PermissionResolveParams::decl(&config),
        PermissionListParams::decl(&config),
        PermissionRequestInfo::decl(&config),
        OperationDecision::decl(&config),
        OperationListParams::decl(&config),
        OperationResolveParams::decl(&config),
        OperationInfo::decl(&config),
        QuestionListParams::decl(&config),
        QuestionResolveParams::decl(&config),
        QuestionRejectParams::decl(&config),
        QuestionOptionInfo::decl(&config),
        QuestionItemInfo::decl(&config),
        QuestionRequestInfo::decl(&config),
        MemoListParams::decl(&config),
        MemoCreateParams::decl(&config),
        MemoUpdateParams::decl(&config),
        MemoIdParams::decl(&config),
        MemoInfo::decl(&config),
        ConnectorCreateParams::decl(&config),
        ConnectorUpdateParams::decl(&config),
        ConnectorInfo::decl(&config),
        ConnectorCapabilityInvocation::decl(&config),
        ConnectorCapabilityInfo::decl(&config),
        ConnectorCatalogEntry::decl(&config),
        ConnectorCatalogError::decl(&config),
        ConnectorCatalogInfo::decl(&config),
        MediaListParams::decl(&config),
        MediaResolveParams::decl(&config),
        MediaRequestInfo::decl(&config),
        WorkspaceInfo::decl(&config),
        WorkspaceSwitchParams::decl(&config),
        WorkspaceSwitchResult::decl(&config),
        WorkspacePathParams::decl(&config),
        WorkspaceEntryKind::decl(&config),
        WorkspaceEntryInfo::decl(&config),
        WorkspaceDirectoryInfo::decl(&config),
        WorkspaceFileInfo::decl(&config),
        ToolExecutionModeInfo::decl(&config),
        ToolExposureInfo::decl(&config),
        ToolInfo::decl(&config),
        SelfAwakeListParams::decl(&config),
        SelfAwakeDiaryInfo::decl(&config),
        SelfAwakeRunInfo::decl(&config),
        SelfAwakePage::decl(&config),
        DirectorListParams::decl(&config),
        DirectorBeatInfo::decl(&config),
        DirectorSceneInfo::decl(&config),
        DirectorExecutionInfo::decl(&config),
        DirectorRunStatus::decl(&config),
        DirectorRunInfo::decl(&config),
        VoiceTtsSynthesizeParams::decl(&config),
        VoiceTtsMode::decl(&config),
        VoiceTtsSynthesizeResult::decl(&config),
        VoiceSpeechSegmentListParams::decl(&config),
        VoiceSpeechSegmentInfo::decl(&config),
    ]
    .into_iter()
    .map(|declaration| format!("export {declaration}"))
    .collect::<Vec<_>>()
    .join("\n\n");

    let client = format!(
        r#"/* eslint-disable */
// @generated by `cargo run -p eden-agent-api --bin generate-types`.
// Do not edit this file by hand.

export const EDEN_AGENT_PROTOCOL_VERSION = {protocol_version} as const
export const EDEN_AGENT_WEBSOCKET_PROTOCOL = {websocket_protocol:?} as const
export const EDEN_AGENT_TOKEN_PROTOCOL_PREFIX = {token_prefix:?} as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | {{ [key: string]: JsonValue }}

{declarations}

export interface RpcMethodMap {{
  initialize: {{ params: InitializeParams; result: InitializeResult }}
  ping: {{ params: Record<string, never>; result: {{ pong: boolean }} }}
  "session.create": {{ params: SessionCreateParams; result: SessionSummary }}
  "session.list": {{ params: SessionListParams; result: SessionSummary[] }}
  "session.read": {{ params: SessionReadParams; result: SessionSummary }}
  "session.rename": {{ params: SessionTitleParams; result: SessionSummary }}
  "session.set_participants": {{ params: SessionParticipantsParams; result: SessionSummary }}
  "session.close": {{ params: SessionReadParams; result: {{ sessionId: SessionId; closed: boolean }} }}
  "session.delete": {{ params: SessionReadParams; result: {{ sessionId: SessionId; deleted: boolean }} }}
  "session.compact": {{ params: SessionCompactParams; result: TurnAccepted }}
  "turn.start": {{ params: TurnStartParams; result: TurnAccepted }}
  "turn.steer": {{ params: TurnQueueParams; result: TurnQueueResult }}
  "turn.follow_up": {{ params: TurnQueueParams; result: TurnQueueResult }}
  "turn.cancel": {{ params: SessionReadParams; result: {{ sessionId: SessionId; cancellationRequested: boolean }} }}
  "event.list": {{ params: EventListParams; result: EventPage }}
  "message.list": {{ params: MessageListParams; result: EventPage }}
  "permission.list": {{ params: PermissionListParams; result: PermissionRequestInfo[] }}
  "permission.mode.get": {{ params: Record<string, never>; result: {{ mode: "restricted" | "full_access" | "takeover" }} }}
  "permission.mode.set": {{ params: {{ mode: "restricted" | "full_access" | "takeover" }}; result: {{ mode: "restricted" | "full_access" | "takeover" }} }}
  "permission.resolve": {{ params: PermissionResolveParams; result: PermissionRequestInfo }}
  "operation.list": {{ params: OperationListParams; result: OperationInfo[] }}
  "operation.resolve": {{ params: OperationResolveParams; result: OperationInfo }}
  "question.list": {{ params: QuestionListParams; result: QuestionRequestInfo[] }}
  "question.resolve": {{ params: QuestionResolveParams; result: QuestionRequestInfo }}
  "question.reject": {{ params: QuestionRejectParams; result: QuestionRequestInfo }}
  "skill.list": {{ params: SkillListParams; result: SkillInfo[] }}
  "skill.read": {{ params: SkillReadParams; result: SkillInfo }}
  "skill.install": {{ params: SkillInstallParams; result: SkillInfo }}
  "skill.enable": {{ params: SkillEnableParams; result: SkillInfo }}
  "skill.uninstall": {{ params: SkillReadParams; result: {{ deleted: boolean }} }}
  "skill.inspect": {{ params: SkillInspectParams; result: SkillPreviewInfo }}
  "skill.install_preview": {{ params: SkillPreviewInstallParams; result: SkillInfo }}
  "plugin.list": {{ params: PluginListParams; result: PluginInfo[] }}
  "plugin.read": {{ params: PluginReadParams; result: PluginInfo }}
  "plugin.inspect": {{ params: PluginInspectParams; result: PluginPreviewInfo }}
  "plugin.install_preview": {{ params: PluginPreviewInstallParams; result: PluginInfo }}
  "plugin.enable": {{ params: PluginEnableParams; result: PluginInfo }}
  "plugin.activate": {{ params: PluginActivateParams; result: PluginInfo }}
  "plugin.uninstall": {{ params: PluginReadParams; result: PluginUninstallResult }}
  "plugin.permissions.set": {{ params: PluginPermissionSetParams; result: PluginInfo }}
  "plugin.market.source.list": {{ params: PluginListParams; result: PluginMarketSourceInfo[] }}
  "plugin.market.source.add": {{ params: PluginMarketSourceAddParams; result: PluginMarketSourceInfo }}
  "plugin.market.source.remove": {{ params: PluginMarketSourceParams; result: {{ deleted: boolean }} }}
  "plugin.market.source.refresh": {{ params: PluginMarketSourceParams; result: PluginMarketSourceInfo }}
  "plugin.market.list": {{ params: PluginMarketListParams; result: PluginMarketReleaseInfo[] }}
  "plugin.market.inspect": {{ params: PluginMarketInspectParams; result: PluginPreviewInfo }}
  "agent.list": {{ params: AgentListParams; result: AgentThreadInfo[] }}
  "agent.read": {{ params: AgentReadParams; result: AgentThreadInfo }}
  "agent.interrupt": {{ params: AgentReadParams; result: AgentThreadInfo }}
  "agent.send": {{ params: AgentMessageParams; result: AgentThreadInfo }}
  "agent.followup": {{ params: AgentMessageParams; result: AgentThreadInfo }}
  "memo.list": {{ params: MemoListParams; result: MemoInfo[] }}
  "memo.create": {{ params: MemoCreateParams; result: MemoInfo }}
  "memo.update": {{ params: MemoUpdateParams; result: MemoInfo }}
  "memo.complete": {{ params: MemoIdParams; result: MemoInfo }}
  "memo.archive": {{ params: MemoIdParams; result: MemoInfo }}
  "connector.list": {{ params: Record<string, never>; result: ConnectorInfo[] }}
  "connector.catalog": {{ params: Record<string, never>; result: ConnectorCatalogInfo }}
  "connector.create": {{ params: ConnectorCreateParams; result: ConnectorInfo }}
  "connector.update": {{ params: ConnectorUpdateParams; result: ConnectorInfo }}
  "workspace.info": {{ params: Record<string, never>; result: WorkspaceInfo }}
  "workspace.switch": {{ params: WorkspaceSwitchParams; result: WorkspaceSwitchResult }}
  "workspace.list": {{ params: WorkspacePathParams; result: WorkspaceDirectoryInfo }}
  "workspace.read": {{ params: WorkspacePathParams; result: WorkspaceFileInfo }}
  "tool.list": {{ params: Record<string, never>; result: ToolInfo[] }}
  "model.read": {{ params: ModelReadParams; result: RuntimeModelInfo }}
  "model.catalog": {{ params: ModelCatalogParams; result: RuntimeModelCatalogInfo }}
  "model.select": {{ params: ModelSelectParams; result: RuntimeModelCatalogInfo }}
  "media.list": {{ params: MediaListParams; result: MediaRequestInfo[] }}
  "media.resolve": {{ params: MediaResolveParams; result: MediaRequestInfo }}
  "voice.tts.synthesize": {{ params: VoiceTtsSynthesizeParams; result: VoiceTtsSynthesizeResult }}
  "voice.tts.list_segments": {{ params: VoiceSpeechSegmentListParams; result: VoiceSpeechSegmentInfo[] }}
  "self_awake.list": {{ params: SelfAwakeListParams; result: SelfAwakePage }}
  "director.list": {{ params: DirectorListParams; result: DirectorRunInfo[] }}
}}

export interface RpcNotificationMap {{
  "server.ready": ReadyNotification
  "session.event": SessionEvent
  "server.warning": {{ code: string; skipped?: number; recovery?: string }}
}}

export async function uploadBlob(
  baseUrl: string,
  capabilityToken: string,
  content: Blob,
): Promise<BlobInfo> {{
  const response = await fetch(`${{baseUrl.replace(/\/$/, "")}}/blobs`, {{
    method: "POST",
    headers: {{ Authorization: `Bearer ${{capabilityToken}}`, "Content-Type": content.type || "application/octet-stream" }},
    body: content,
  }})
  if (!response.ok) throw new Error(`Blob upload failed: ${{response.status}} ${{await response.text()}}`)
  return response.json() as Promise<BlobInfo>
}}

type PendingRequest = {{
  resolve(value: unknown): void
  reject(error: Error): void
}}

export class EdenAgentRpcClient {{
  private socket: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private closeListeners = new Set<() => void>()

  async connect(
    url: string,
    capabilityToken: string,
    clientVersion = "dev",
    runtimeOrigin: RuntimeOrigin = "mon",
  ): Promise<InitializeResult> {{
    if (this.socket) throw new Error("Eden Agent RPC client is already connected")
    const socket = new WebSocket(url, [
      EDEN_AGENT_WEBSOCKET_PROTOCOL,
      `${{EDEN_AGENT_TOKEN_PROTOCOL_PREFIX}}${{capabilityToken}}`,
    ])
    this.socket = socket
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)))
    socket.addEventListener("close", () => this.handleClose())
    await new Promise<void>((resolve, reject) => {{
      socket.addEventListener("open", () => resolve(), {{ once: true }})
      socket.addEventListener("error", () => reject(new Error("Eden Agent WebSocket connection failed")), {{ once: true }})
    }})
    return this.request("initialize", {{
      protocolVersion: EDEN_AGENT_PROTOCOL_VERSION,
      clientName: "eden-agent-web",
      clientVersion,
      capabilities: ["session-events"],
      runtimeOrigin,
    }})
  }}

  request<K extends keyof RpcMethodMap>(
    method: K,
    params: RpcMethodMap[K]["params"],
  ): Promise<RpcMethodMap[K]["result"]> {{
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {{
      return Promise.reject(new Error("Eden Agent RPC client is not connected"))
    }}
    const id = this.nextId++
    return new Promise((resolve, reject) => {{
      this.pending.set(id, {{ resolve: resolve as (value: unknown) => void, reject }})
      socket.send(JSON.stringify(
        {{ jsonrpc: "2.0", id, method, params }},
        (_key, value) => typeof value === "bigint" ? Number(value) : value,
      ))
    }})
  }}

  on<K extends keyof RpcNotificationMap>(
    method: K,
    listener: (params: RpcNotificationMap[K]) => void,
  ): () => void {{
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener as (params: unknown) => void)
    this.listeners.set(method, listeners)
    return () => listeners.delete(listener as (params: unknown) => void)
  }}

  onClose(listener: () => void): () => void {{
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }}

  close(): void {{
    this.socket?.close(1000, "client closed")
    this.socket = null
    this.handleClose()
  }}

  private handleMessage(raw: string): void {{
    let message: {{ id?: number; result?: unknown; error?: RpcError; method?: string; params?: unknown }}
    try {{
      message = JSON.parse(raw)
    }} catch {{
      return
    }}
    if (typeof message.id === "number") {{
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${{message.error.code}}: ${{message.error.message}}`))
      else pending.resolve(message.result)
      return
    }}
    if (message.method) {{
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params)
    }}
  }}

  private handleClose(): void {{
    for (const pending of this.pending.values()) pending.reject(new Error("Eden Agent RPC connection closed"))
    this.pending.clear()
    this.socket = null
    for (const listener of this.closeListeners) listener()
  }}
}}
"#,
        protocol_version = eden_agent_api::PROTOCOL_VERSION,
        websocket_protocol = eden_agent_api::WEBSOCKET_PROTOCOL,
        token_prefix = eden_agent_api::TOKEN_PROTOCOL_PREFIX,
    );
    fs::write(&output, client)?;
    println!("{}", output.display());
    Ok(())
}
