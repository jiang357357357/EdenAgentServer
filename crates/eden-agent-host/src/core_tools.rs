use super::{CoreClient, HostServices, output};
use async_trait::async_trait;
use base64::Engine;
use eden_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolExecutionMode,
    ToolFailure, ToolOutput,
};
use eden_agent_domain::{BlobId, SessionId, TurnId};
use futures::StreamExt;
use reqwest::{Method, Url, multipart};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy)]
enum Action {
    ListAssistants,
    SwitchAssistant,
    SelfAwakeState,
    ListSelfAwakeDiaries,
    ReadSelfAwakeDiary,
    AnalyzeImage,
    EmailStatus,
    SendEmail,
    ListQqBots,
    QqTargets,
    ReadQqMessages,
    SendQqMessage,
    ContactUser,
    ListCharacterActions,
    SwitchVisual,
    ListStickers,
    RememberSticker,
    SendSticker,
    DeleteSticker,
}

impl Action {
    const ALL: [Self; 19] = [
        Self::ListAssistants,
        Self::SwitchAssistant,
        Self::SelfAwakeState,
        Self::ListSelfAwakeDiaries,
        Self::ReadSelfAwakeDiary,
        Self::AnalyzeImage,
        Self::EmailStatus,
        Self::SendEmail,
        Self::ListQqBots,
        Self::QqTargets,
        Self::ReadQqMessages,
        Self::SendQqMessage,
        Self::ContactUser,
        Self::ListCharacterActions,
        Self::SwitchVisual,
        Self::ListStickers,
        Self::RememberSticker,
        Self::SendSticker,
        Self::DeleteSticker,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::ListAssistants => "list_assistants",
            Self::SwitchAssistant => "switch_session_assistant",
            Self::SelfAwakeState => "get_self_awake_state",
            Self::ListSelfAwakeDiaries => "list_self_awake_diaries",
            Self::ReadSelfAwakeDiary => "read_self_awake_diary",
            Self::AnalyzeImage => "analyze_image",
            Self::EmailStatus => "external_email_status",
            Self::SendEmail => "send_external_email",
            Self::ListQqBots => "qq_bot_list",
            Self::QqTargets => "qq_bot_targets",
            Self::ReadQqMessages => "read_qq_messages",
            Self::SendQqMessage => "send_qq_message",
            Self::ContactUser => "contact_user",
            Self::ListCharacterActions => "list_character_actions",
            Self::SwitchVisual => "switch_character_action",
            Self::ListStickers => "list_character_stickers",
            Self::RememberSticker => "remember_character_sticker",
            Self::SendSticker => "send_character_sticker",
            Self::DeleteSticker => "delete_character_sticker",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::ListAssistants => {
                "列出当前用户可用的真实助手及其 ID、助手名和角色名。只在目标名称不明确、存在重名或用户要求查看助手时调用；明确点名时可直接调用 switch_session_assistant。"
            }
            Self::SwitchAssistant => {
                "把当前会话持久交接给指定的真实助手，并从下一根回合由目标助手接手。用户说\u{201c}叫某助手出来\u{201d}、\u{201c}换某助手来\u{201d}、\u{201c}让某助手接手\u{201d}或\u{201c}我想和某助手说话\u{201d}时必须调用；可直接传 assistantName，或传 list_assistants 返回的 assistantId。不得用角色动作、旁白或普通回复代替。"
            }
            Self::SelfAwakeState => "Read durable self-awake schedules",
            Self::ListSelfAwakeDiaries => "List self-awake diaries from Mon Core",
            Self::ReadSelfAwakeDiary => "Read one self-awake diary from Mon Core",
            Self::AnalyzeImage => "Analyze an image through Mon Core vision",
            Self::EmailStatus => "Read external email delivery status",
            Self::SendEmail => "Send external email through Mon Core and MonOs",
            Self::ListQqBots => "List QQ bots owned by the current user",
            Self::QqTargets => "List allowed QQ bot delivery targets",
            Self::ReadQqMessages => "Read QQ messages for a bot target",
            Self::SendQqMessage => "Send a QQ message through Mon Core",
            Self::ContactUser => "Contact the current user through QQ or external email",
            Self::ListCharacterActions => "List the current character visual actions",
            Self::SwitchVisual => "Select a character action and emit a durable UI event",
            Self::ListStickers => "List the current character stickers",
            Self::RememberSticker => "Save a character sticker from an image URL",
            Self::SendSticker => "Select a character sticker and emit a durable UI event",
            Self::DeleteSticker => "Delete a character sticker",
        }
    }

    fn mutates(self) -> bool {
        matches!(
            self,
            Self::SwitchAssistant
                | Self::SendEmail
                | Self::SendQqMessage
                | Self::ContactUser
                | Self::SwitchVisual
                | Self::RememberSticker
                | Self::SendSticker
                | Self::DeleteSticker
        )
    }
}

pub(super) fn tools(host: HostServices) -> Vec<Arc<dyn Tool>> {
    Action::ALL
        .iter()
        .copied()
        .map(|action| {
            Arc::new(CoreTool {
                host: host.clone(),
                action,
            }) as Arc<dyn Tool>
        })
        .collect()
}

struct CoreTool {
    host: HostServices,
    action: Action,
}

#[async_trait]
impl Tool for CoreTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(self.action.name(), self.action.description());
        definition.parameters = parameters(self.action);
        if self.action.mutates() {
            definition.execution_mode = ToolExecutionMode::Sequential;
        }
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        self.action.mutates().then(|| PermissionRequest {
            permission: "mon.write".to_owned(),
            patterns: permission_patterns(self.action, arguments),
            always: vec![],
        })
    }

    fn timeout(&self) -> Option<Duration> {
        Some(Duration::from_secs(35))
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        if matches!(self.action, Action::SelfAwakeState) {
            let jobs = self
                .host
                .store
                .list_jobs(Some("self_awake"), 100)
                .await
                .map_err(store_error)?;
            let next = jobs
                .iter()
                .filter(|job| job.state == "scheduled")
                .map(|job| job.due_at)
                .min();
            return Ok(output(
                json!({"enabled":true,"nextWakeAt":next,"jobs":jobs}),
            ));
        }
        let core = self
            .host
            .core_client(context.session_id.as_deref())
            .await
            .ok_or_else(|| {
                ToolFailure::new(
                    "core_unconfigured",
                    "Core credentials are unavailable; authenticate and refresh the model catalog",
                )
            })?;
        let core = &core;
        let mut effective_arguments = call.arguments.clone();
        if let Some(operation_id) = context.metadata.get("operationId").and_then(Value::as_str)
            && let Some(arguments) = effective_arguments.as_object_mut()
        {
            let request_id = match self.action {
                Action::SendEmail => Some(format!("{operation_id}-email")),
                Action::SendQqMessage => Some(format!("{operation_id}-qq")),
                Action::ContactUser => Some(operation_id.to_owned()),
                _ => None,
            };
            if let Some(request_id) = request_id {
                arguments
                    .entry("requestId".to_owned())
                    .or_insert(Value::String(request_id));
            }
        }
        let args = &effective_arguments;
        let value = match self.action {
            Action::ListAssistants => {
                let response = core.request(Method::GET, "/api/assistants/", None).await?;
                let assistants = array_results(&response)
                    .iter()
                    .take(100)
                    .filter_map(assistant_tool_summary)
                    .collect::<Vec<_>>();
                json!({"count":assistants.len(),"assistants":assistants})
            }
            Action::SwitchAssistant => switch_assistant(&self.host, core, args, &context).await?,
            Action::ListSelfAwakeDiaries => {
                let pairs = vec![(
                    "limit",
                    args.get("limit")
                        .and_then(Value::as_i64)
                        .unwrap_or(5)
                        .clamp(1, 12)
                        .to_string(),
                )];
                core.request(
                    Method::GET,
                    &query_path("/api/agent/self-awake/diaries/context/", &pairs),
                    None,
                )
                .await?
            }
            Action::ReadSelfAwakeDiary => {
                let id = required_id(args, &["id"])?;
                core.request(
                    Method::GET,
                    &format!("/api/agent/self-awake/diaries/{id}/"),
                    None,
                )
                .await?
            }
            Action::AnalyzeImage => {
                core.request(
                    Method::POST,
                    "/api/ai/entities/analyze-image/",
                    Some(normalize_keys(
                        args,
                        &[("imageUrl", "image_url"), ("aiEntityId", "ai_entity_id")],
                    )),
                )
                .await?
            }
            Action::EmailStatus => {
                core.request(Method::GET, "/api/agent/external-email/status/", None)
                    .await?
            }
            Action::SendEmail => send_email(core, args).await?,
            Action::ListQqBots => list_qq_bots(core, args).await?,
            Action::QqTargets => qq_management(core, args).await?,
            Action::ReadQqMessages => read_qq(core, args).await?,
            Action::SendQqMessage => send_qq(core, args).await?,
            Action::ContactUser => contact_user(core, args).await?,
            Action::ListCharacterActions => {
                let session = required_session(&context)?;
                let character = character_context(&self.host, args, Some(session)).await?;
                let actions = core
                    .request(
                        Method::GET,
                        &format!("/api/characters/{}/visual-actions/", character.id),
                        None,
                    )
                    .await?;
                let current = current_character_action(&self.host, session, &character.id).await?;
                json!({"character":{"id":character.id,"name":character.name,"visualPreference":character.visual_preference},"current":current,"actions":array_results(&actions)})
            }
            Action::SwitchVisual => {
                switch_character_action(&self.host, core, args, &context).await?
            }
            Action::ListStickers => list_stickers(&self.host, core, args, &context).await?,
            Action::RememberSticker => {
                let character =
                    character_id(&self.host, args, context.session_id.as_deref()).await?;
                remember_sticker(&self.host, core, &character, args, &context).await?
            }
            Action::SendSticker => send_sticker(&self.host, core, args, &context).await?,
            Action::DeleteSticker => delete_sticker(&self.host, core, args, &context).await?,
            Action::SelfAwakeState => unreachable!(),
        };
        Ok(output(value))
    }
}

fn parameters(action: Action) -> Value {
    let properties = match action {
        Action::SwitchAssistant => json!({
            "assistantId":id_schema(),
            "assistantName":{
                "type":"string",
                "minLength":1,
                "maxLength":120,
                "description":"目标助手名或角色名，例如\u{201c}阿罗娜\u{201d}。与 assistantId 二选一；已知名称时优先使用此字段。"
            }
        }),
        Action::ListSelfAwakeDiaries => {
            json!({"limit":{"type":"integer","minimum":1,"maximum":12}})
        }
        Action::ReadSelfAwakeDiary => json!({"id":id_schema()}),
        Action::AnalyzeImage => {
            json!({"imageUrl":{"type":"string","minLength":1,"maxLength":8192},"prompt":{"type":"string","maxLength":8000},"aiEntityId":id_schema()})
        }
        Action::SendEmail => {
            json!({"subject":{"type":"string","minLength":1,"maxLength":998},"content":{"type":"string","minLength":1,"maxLength":200000},"html":{"type":"string","maxLength":1000000},"to":{"type":"array","maxItems":100,"items":{"type":"string","minLength":3,"maxLength":320}},"requestId":{"type":"string","minLength":1,"maxLength":200}})
        }
        Action::ListQqBots => {
            json!({"ownerOnly":{"type":"boolean"},"status":{"type":"string","enum":["online","offline","error"]}})
        }
        Action::QqTargets => json!({"botId":id_schema(),"includeUnapproved":{"type":"boolean"}}),
        Action::ReadQqMessages => merge(
            qq_target_properties(),
            json!({"limit":{"type":"integer","minimum":1,"maximum":100},"beforeId":{"type":"integer","minimum":1}}),
        ),
        Action::SendQqMessage => merge(
            qq_target_properties(),
            json!({"content":{"type":"string","minLength":1,"maxLength":12000},"metadata":{"type":"object"},"requestId":{"type":"string","minLength":1,"maxLength":200}}),
        ),
        Action::ContactUser => {
            json!({"title":{"type":"string","maxLength":998},"message":{"type":"string","minLength":1,"maxLength":200000},"channel":{"type":"string","enum":["auto","qq","email","both"]},"sourceType":{"type":"string","maxLength":100},"sourceId":{"type":"string","maxLength":200},"metadata":{"type":"object"},"requestId":{"type":"string","minLength":1,"maxLength":200}})
        }
        Action::ListCharacterActions => json!({}),
        Action::SwitchVisual => {
            json!({
                "立绘动作":{"type":"string","minLength":1,"maxLength":200,"description":"当前角色实际拥有的立绘动作名称；不切换图片时填写“保持当前”。"},
                "表情符号":{"type":"string","enum":["无","疑问","惊讶","汗滴","爱心","生气","叹气","无语","低落","困倦"]},
                "立绘动效":{"type":"string","enum":["无","上下跳动","向前靠近","向后退开","左右摇晃","连续弹跳","轻微上下浮动","快速颤抖","垂直震动","轻微下沉","强调放大"]}
            })
        }
        Action::ListStickers => json!({"query":{"type":"string","maxLength":200}}),
        Action::RememberSticker => {
            json!({"imageUrl":{"type":"string","minLength":1,"maxLength":8192},"name":{"type":"string","minLength":1,"maxLength":200},"description":{"type":"string","minLength":1,"maxLength":2000},"emotion":{"type":"string","minLength":1,"maxLength":200},"intent":{"type":"string","minLength":1,"maxLength":500},"aliases":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"string","minLength":1,"maxLength":200}}})
        }
        Action::SendSticker => {
            json!({"sticker":{"type":"string","minLength":1,"maxLength":200}})
        }
        Action::DeleteSticker => json!({"sticker":{"type":"string","minLength":1,"maxLength":200}}),
        _ => json!({}),
    };
    let required: Vec<&str> = match action {
        Action::SwitchAssistant => Vec::new(),
        Action::ReadSelfAwakeDiary => vec!["id"],
        Action::AnalyzeImage => vec!["imageUrl"],
        Action::SendEmail => vec!["subject", "content"],
        Action::SendQqMessage => vec!["content"],
        Action::ContactUser => vec!["message"],
        Action::SwitchVisual => vec!["立绘动作", "表情符号", "立绘动效"],
        Action::RememberSticker => vec![
            "imageUrl",
            "name",
            "description",
            "emotion",
            "intent",
            "aliases",
        ],
        Action::SendSticker | Action::DeleteSticker => vec!["sticker"],
        _ => Vec::new(),
    };
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn id_schema() -> Value {
    json!({"anyOf":[{"type":"integer","minimum":1},{"type":"string","minLength":1,"maxLength":128}]})
}

fn permission_patterns(action: Action, arguments: &Value) -> Vec<String> {
    let target = match action {
        Action::SwitchAssistant => value_id(arguments.get("assistantId")).or_else(|| {
            arguments
                .get("assistantName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("name:{value}"))
        }),
        Action::SendEmail => Some("external-email".to_owned()),
        Action::SendQqMessage => arguments
            .get("targetQqNumber")
            .and_then(Value::as_str)
            .map(|value| format!("qq:{value}"))
            .or_else(|| Some("qq:default".to_owned())),
        Action::ContactUser => Some(format!(
            "channel:{}",
            arguments
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("auto")
        )),
        Action::SwitchVisual => arguments
            .get("立绘动作")
            .and_then(Value::as_str)
            .map(|value| format!("action:{value}")),
        Action::RememberSticker => arguments
            .get("name")
            .and_then(Value::as_str)
            .map(|value| format!("sticker:new:{value}")),
        Action::SendSticker | Action::DeleteSticker => arguments
            .get("sticker")
            .and_then(Value::as_str)
            .map(|value| format!("sticker:{value}")),
        _ => None,
    };
    std::iter::once(action.name().to_owned())
        .chain(target)
        .collect()
}

async fn switch_assistant(
    host: &HostServices,
    core: &CoreClient,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let (id, assistant) = resolve_assistant(core, args).await?;
    let session_id = context
        .session_id
        .as_deref()
        .ok_or_else(|| {
            ToolFailure::new("missing_session", "assistant switching requires a session")
        })?
        .parse::<SessionId>()
        .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))?;
    let turn_id = turn_id(context).ok_or_else(|| {
        ToolFailure::new(
            "missing_turn",
            "assistant switching requires an active root turn",
        )
    })?;
    let participant = participant_from_assistant(&assistant);
    let source_participant = host
        .store
        .get_session(session_id)
        .await
        .map_err(store_error)?
        .participants
        .into_iter()
        .next();
    let job = host
        .store
        .schedule_assistant_handoff(
            session_id,
            turn_id,
            json!({
                "assistantId":id.clone(),
                "assistant":assistant.clone(),
                "participant":participant.clone(),
                "sourceParticipant":source_participant,
                "sourceTurnId":turn_id,
            }),
            &format!("assistant-handoff:{session_id}:{turn_id}"),
        )
        .await
        .map_err(store_error)?;
    let scheduled_assistant = job.payload.get("assistant").cloned().unwrap_or(assistant);
    let scheduled_participant = job
        .payload
        .get("participant")
        .cloned()
        .unwrap_or(participant);
    let assistant = assistant_tool_summary(&scheduled_assistant).ok_or_else(|| {
        ToolFailure::new(
            "invalid_assistant",
            "assistant response has no stable identifier",
        )
    })?;
    let participant = participant_tool_summary(&scheduled_participant);
    Ok(json!({
        "assistant":assistant,
        "participant":participant,
        "jobId":job.id,
        "historyPreserved":true,
        "effectiveFrom":"next_root_run",
        "status":"scheduled",
    }))
}

async fn resolve_assistant(
    core: &CoreClient,
    args: &Value,
) -> Result<(String, Value), ToolFailure> {
    if let Some(id) = value_id(args.get("assistantId")) {
        let assistant = core
            .request(Method::GET, &format!("/api/assistants/{id}/"), None)
            .await?;
        return Ok((id, assistant));
    }

    let requested_name = required_text(args, "assistantName")?;
    let normalized = normalize_assistant_name(requested_name);
    let response = core.request(Method::GET, "/api/assistants/", None).await?;
    let matches = array_results(&response)
        .into_iter()
        .filter(|assistant| assistant_matches_name(assistant, &normalized))
        .collect::<Vec<_>>();
    let assistant = match matches.as_slice() {
        [] => {
            return Err(ToolFailure::new(
                "assistant_not_found",
                format!(
                    "没有找到名称或角色名为\u{201c}{requested_name}\u{201d}的助手；请先调用 list_assistants 查看可用目标"
                ),
            ));
        }
        [assistant] => assistant,
        _ => {
            return Err(ToolFailure::new(
                "assistant_name_ambiguous",
                format!(
                    "名称\u{201c}{requested_name}\u{201d}匹配多个助手；请先调用 list_assistants，并改用 assistantId"
                ),
            ));
        }
    };
    let id = assistant
        .get("id")
        .and_then(|value| value_id(Some(value)))
        .ok_or_else(|| ToolFailure::new("invalid_assistant", "匹配的助手缺少稳定 ID"))?;
    let assistant = core
        .request(Method::GET, &format!("/api/assistants/{id}/"), None)
        .await?;
    Ok((id, assistant))
}

fn assistant_matches_name(assistant: &Value, requested_name: &str) -> bool {
    let character_name = assistant
        .get("character")
        .and_then(|character| character.get("name"))
        .and_then(Value::as_str);
    [
        assistant.get("name").and_then(Value::as_str),
        character_name,
    ]
    .into_iter()
    .flatten()
    .any(|candidate| normalize_assistant_name(candidate) == requested_name)
}

fn normalize_assistant_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

async fn switch_character_action(
    host: &HostServices,
    core: &CoreClient,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let session = required_session(context)?;
    let character = character_context(host, args, Some(session)).await?;
    let selector = required_text(args, "立绘动作")?;
    let (motion_label, motion) = performance_choice(args, "立绘动效", MOTION_CODES)?;
    let (effect_label, effect) = performance_choice(args, "表情符号", EFFECT_CODES)?;
    let raw = core
        .request(
            Method::GET,
            &format!("/api/characters/{}/visual-actions/", character.id),
            None,
        )
        .await?;
    let actions = array_results(&raw)
        .into_iter()
        .filter(|item| item.get("enabled").and_then(Value::as_bool) != Some(false))
        .collect::<Vec<_>>();
    let current = current_character_action(host, session, &character.id).await?;
    let (action, group, group_item, preserved_image) = if selector == HOLD_ACTION {
        let current = current.as_ref().ok_or_else(|| {
            ToolFailure::new(
                "action_not_found",
                "当前会话还没有角色动作，不能使用“保持当前”",
            )
        })?;
        let action = current
            .get("action")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| ToolFailure::new("action_not_found", "当前角色动作无效"))?;
        (
            action,
            current.get("group").cloned().unwrap_or(Value::Null),
            current.get("groupItem").cloned().unwrap_or(Value::Null),
            current
                .get("imageUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned(),
        )
    } else {
        let action = actions
            .iter()
            .find(|item| action_matches(item, selector))
            .cloned()
            .ok_or_else(|| {
                let available = actions
                    .iter()
                    .filter_map(action_label)
                    .collect::<Vec<_>>()
                    .join("、");
                ToolFailure::new(
                    "action_not_found",
                    format!(
                        "没有找到立绘动作“{selector}”。可用立绘动作：{}；或选择“{HOLD_ACTION}”",
                        if available.is_empty() {
                            "暂无"
                        } else {
                            &available
                        }
                    ),
                )
            })?;
        (action, Value::Null, Value::Null, String::new())
    };
    let image_url = if preserved_image.is_empty() {
        action_image_url(&action, &character.visual_preference)
    } else {
        preserved_image
    };
    if current.as_ref().is_some_and(|current| {
        same_action(current.get("action"), Some(&action))
            && current
                .get("motion")
                .and_then(Value::as_str)
                .unwrap_or("none")
                == motion
            && current
                .get("effect")
                .and_then(Value::as_str)
                .unwrap_or("none")
                == effect
    }) {
        return Ok(json!({"unchanged":true,"current":current}));
    }
    let time = now_millis();
    let state = json!({
        "sessionId":session,
        "characterId":json_id(&character.id),
        "characterName":character.name,
        "action":action,
        "group":group,
        "groupItem":group_item,
        "imageUrl":image_url,
        "reason":"智能体自主选择角色表现",
        "source":"tool",
        "motion":motion,
        "effect":effect,
        "intensity":"normal",
        "effectAnchor":"head_right",
        "performanceID":format!("perf_{time}"),
        "time":time,
    });
    host.store
        .append_event(
            session,
            turn_id(context),
            "character.action.changed",
            state.clone(),
        )
        .await
        .map_err(store_error)?;
    Ok(json!({
        "立绘动作":selector,
        "表情符号":effect_label,
        "立绘动效":motion_label,
        "state":state,
    }))
}

const HOLD_ACTION: &str = "保持当前";
const MOTION_CODES: &[(&str, &str)] = &[
    ("无", "none"),
    ("上下跳动", "jump"),
    ("向前靠近", "approach"),
    ("向后退开", "retreat"),
    ("左右摇晃", "shake"),
    ("连续弹跳", "bounce"),
    ("轻微上下浮动", "float"),
    ("快速颤抖", "tremble"),
    ("垂直震动", "vertical_shake"),
    ("轻微下沉", "sink"),
    ("强调放大", "emphasize"),
];
const EFFECT_CODES: &[(&str, &str)] = &[
    ("无", "none"),
    ("疑问", "question"),
    ("惊讶", "exclamation"),
    ("汗滴", "sweat"),
    ("爱心", "heart"),
    ("生气", "anger"),
    ("叹气", "sigh"),
    ("无语", "speechless"),
    ("低落", "gloomy"),
    ("困倦", "sleepy"),
];

#[derive(Debug)]
struct CharacterContext {
    id: String,
    name: String,
    visual_preference: String,
}

fn performance_choice<'a>(
    args: &'a Value,
    field: &str,
    choices: &'static [(&'static str, &'static str)],
) -> Result<(&'a str, &'static str), ToolFailure> {
    let label = required_text(args, field)?;
    choices
        .iter()
        .find(|(candidate, _)| *candidate == label)
        .map(|(_, code)| (label, *code))
        .ok_or_else(|| {
            ToolFailure::new(
                "invalid_arguments",
                format!(
                    "“{field}”不支持“{label}”，可选值：{}",
                    choices
                        .iter()
                        .map(|(label, _)| *label)
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            )
        })
}

fn action_matches(action: &Value, selector: &str) -> bool {
    let selector = selector.trim().to_lowercase();
    ["id", "intent", "action_key", "name", "action_label"]
        .iter()
        .filter_map(|key| value_id(action.get(*key)))
        .chain(
            action
                .get("aliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        )
        .any(|candidate| candidate.trim().to_lowercase() == selector)
}

fn action_label(action: &Value) -> Option<&str> {
    ["name", "action_label", "intent"]
        .iter()
        .find_map(|key| action.get(*key).and_then(Value::as_str))
        .or_else(|| action.get("id").and_then(Value::as_str))
}

fn action_identity(action: Option<&Value>) -> Option<String> {
    let action = action?.as_object()?;
    ["id", "intent", "name", "action_key", "action_label"]
        .iter()
        .find_map(|key| value_id(action.get(*key)).map(|value| format!("{key}:{value}")))
}

fn same_action(left: Option<&Value>, right: Option<&Value>) -> bool {
    let left = action_identity(left);
    left.is_some() && left == action_identity(right)
}

fn action_image_url(action: &Value, preference: &str) -> String {
    let static_url = action
        .get("static_image_url")
        .or_else(|| action.get("staticImageUrl"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let dynamic_url = action
        .get("dynamic_preview_url")
        .or_else(|| action.get("dynamicPreviewUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .or_else(|| {
            action
                .get("dynamic_frames")
                .or_else(|| action.get("dynamicFrames"))
                .and_then(Value::as_array)
                .and_then(|frames| frames.first())
                .and_then(|frame| frame.get("file_url").or_else(|| frame.get("fileUrl")))
                .and_then(Value::as_str)
                .map(str::trim)
        })
        .unwrap_or_default();
    match (preference, dynamic_url.is_empty(), static_url.is_empty()) {
        ("dynamic", false, _) => dynamic_url.to_owned(),
        (_, _, false) => static_url.to_owned(),
        _ => dynamic_url.to_owned(),
    }
}

async fn list_stickers(
    host: &HostServices,
    core: &CoreClient,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let character = character_id(host, args, context.session_id.as_deref()).await?;
    let pairs = vec![
        ("enabled", "true".to_owned()),
        (
            "q",
            args.get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
    ];
    core.request(
        Method::GET,
        &query_path(&format!("/api/characters/{character}/stickers/"), &pairs),
        None,
    )
    .await
}

async fn remember_sticker(
    host: &HostServices,
    core: &CoreClient,
    character: &str,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let image_url = args
        .get("imageUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", "imageUrl is required"))?;
    let aliases = args
        .get("aliases")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for field in ["name", "description", "emotion", "intent"] {
        if args
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(ToolFailure::new(
                "invalid_arguments",
                format!("{field} is required"),
            ));
        }
    }
    if aliases.is_empty() {
        return Err(ToolFailure::new(
            "invalid_arguments",
            "at least one non-empty alias is required",
        ));
    }
    let (bytes, mime, filename) = read_sticker_image(host, core, context, image_url).await?;
    let mut form = multipart::Form::new();
    for field in ["name", "description", "emotion", "intent"] {
        form = form.text(
            field.to_owned(),
            args[field].as_str().unwrap_or_default().to_owned(),
        );
    }
    form = form.text(
        "aliases",
        serde_json::to_string(&aliases)
            .map_err(|error| ToolFailure::new("invalid_arguments", error.to_string()))?,
    );
    let image = multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|error| ToolFailure::new("invalid_image", error.to_string()))?;
    form = form.part("image", image);
    let path = format!("/api/characters/{character}/stickers/");
    let response = core
        .client
        .post(core.api_url(&path)?)
        .header(reqwest::header::AUTHORIZATION, core.authorization())
        .multipart(form)
        .send()
        .await
        .map_err(|error| ToolFailure::new("core_unavailable", error.to_string()))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| ToolFailure::new("core_read_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(ToolFailure::new(
            "core_request_failed",
            format!(
                "Mon Core returned {status}: {}",
                String::from_utf8_lossy(&body)
            ),
        ));
    }
    serde_json::from_slice(&body)
        .map_err(|error| ToolFailure::new("core_invalid_json", error.to_string()))
}

async fn read_sticker_image(
    host: &HostServices,
    core: &CoreClient,
    context: &ToolCallContext,
    source: &str,
) -> Result<(Vec<u8>, String, String), ToolFailure> {
    const LIMIT: usize = 10 * 1024 * 1024;
    let (bytes, mime, filename) = if let Some(reference) = source.strip_prefix("attachment://") {
        let filename = percent_decode(reference)?;
        let attachment = context
            .metadata
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|attachment| {
                attachment.get("filename").and_then(Value::as_str) == Some(filename.as_str())
            })
            .ok_or_else(|| {
                ToolFailure::new(
                    "attachment_not_found",
                    format!("当前消息中不存在附件：{filename}"),
                )
            })?;
        let id = attachment
            .get("blobId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolFailure::new("invalid_attachment", "附件缺少 blobId"))?
            .parse::<BlobId>()
            .map_err(|error| ToolFailure::new("invalid_attachment", error.to_string()))?;
        let blobs = host.blobs.as_ref().ok_or_else(|| {
            ToolFailure::new("blob_unavailable", "当前运行环境没有配置 Blob 服务")
        })?;
        let (record, bytes) = blobs
            .read(id)
            .await
            .map_err(|error| ToolFailure::new("attachment_unavailable", error.to_string()))?;
        (bytes, record.mime, filename)
    } else if let Some(data) = source.strip_prefix("data:") {
        let (header, encoded) = data
            .split_once(',')
            .ok_or_else(|| ToolFailure::new("invalid_image", "invalid data URL"))?;
        if !header.ends_with(";base64") {
            return Err(ToolFailure::new(
                "invalid_image",
                "only base64 image data URLs are supported",
            ));
        }
        if encoded.len() > (LIMIT * 4 / 3) + 4 {
            return Err(ToolFailure::new("invalid_image", "image exceeds 10 MiB"));
        }
        let mime = header.trim_end_matches(";base64").to_owned();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| ToolFailure::new("invalid_image", error.to_string()))?;
        let extension = mime_guess::get_mime_extensions_str(&mime)
            .and_then(|items| items.first())
            .copied()
            .unwrap_or("png");
        (bytes, mime, format!("sticker.{extension}"))
    } else if source.starts_with("http://") || source.starts_with("https://") {
        let response = core
            .client
            .get(source)
            .send()
            .await
            .map_err(|error| ToolFailure::new("image_unavailable", error.to_string()))?;
        if !response.status().is_success() {
            return Err(ToolFailure::new(
                "image_unavailable",
                format!("image server returned {}", response.status()),
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > LIMIT as u64)
        {
            return Err(ToolFailure::new("invalid_image", "image exceeds 10 MiB"));
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .to_owned();
        let filename = Url::parse(source)
            .ok()
            .and_then(|url| url.path_segments()?.next_back().map(str::to_owned))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "sticker.png".to_owned());
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| ToolFailure::new("image_unavailable", error.to_string()))?;
            if bytes.len().saturating_add(chunk.len()) > LIMIT {
                return Err(ToolFailure::new("invalid_image", "image exceeds 10 MiB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        (bytes, mime, filename)
    } else {
        let path = if source.starts_with("file://") {
            Url::parse(source)
                .map_err(|error| ToolFailure::new("invalid_image", error.to_string()))?
                .to_file_path()
                .map_err(|_| ToolFailure::new("invalid_image", "invalid local file URL"))?
        } else {
            PathBuf::from(source)
        };
        if !path.is_absolute() || !path.is_file() {
            return Err(ToolFailure::new(
                "invalid_image",
                "imageUrl must be an attachment reference, absolute local path, file URL, data URL, or HTTP(S) URL",
            ));
        }
        let length = tokio::fs::metadata(&path)
            .await
            .map_err(|error| ToolFailure::new("image_unavailable", error.to_string()))?
            .len();
        if length > LIMIT as u64 {
            return Err(ToolFailure::new("invalid_image", "image exceeds 10 MiB"));
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| ToolFailure::new("image_unavailable", error.to_string()))?;
        let mime = mime_guess::from_path(&path)
            .first_or_octet_stream()
            .essence_str()
            .to_owned();
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("sticker.png")
            .to_owned();
        (bytes, mime, filename)
    };
    if bytes.len() > LIMIT || !mime.starts_with("image/") {
        return Err(ToolFailure::new(
            "invalid_image",
            "sticker must be an image smaller than 10 MiB",
        ));
    }
    Ok((bytes, mime, filename))
}

fn percent_decode(value: &str) -> Result<String, ToolFailure> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let encoded = bytes.get(index + 1..index + 3).ok_or_else(|| {
                ToolFailure::new("invalid_attachment", "附件名称包含无效的百分号编码")
            })?;
            let encoded = std::str::from_utf8(encoded)
                .map_err(|error| ToolFailure::new("invalid_attachment", error.to_string()))?;
            decoded.push(u8::from_str_radix(encoded, 16).map_err(|_| {
                ToolFailure::new("invalid_attachment", "附件名称包含无效的百分号编码")
            })?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded)
        .map_err(|error| ToolFailure::new("invalid_attachment", error.to_string()))
}

async fn send_sticker(
    host: &HostServices,
    core: &CoreClient,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let character = character_id(host, args, context.session_id.as_deref()).await?;
    let raw = list_stickers(host, core, args, context).await?;
    let requested = required_text(args, "sticker")?;
    let sticker = array_results(&raw)
        .into_iter()
        .find(|item| sticker_matches(item, requested))
        .ok_or_else(|| ToolFailure::new("sticker_not_found", "character sticker was not found"))?;
    let part = sticker_part(&sticker, &character)?;
    let session = required_session(context)?;
    host.store
        .append_event(
            session,
            turn_id(context),
            "character.sticker.sent",
            json!({"sticker":sticker,"part":part}),
        )
        .await
        .map_err(store_error)?;
    Ok(json!({"sticker":sticker,"part":part}))
}

async fn delete_sticker(
    host: &HostServices,
    core: &CoreClient,
    args: &Value,
    context: &ToolCallContext,
) -> Result<Value, ToolFailure> {
    let character = character_id(host, args, context.session_id.as_deref()).await?;
    let requested = required_text(args, "sticker")?;
    let raw = list_stickers(host, core, &json!({"query":""}), context).await?;
    let sticker = array_results(&raw)
        .into_iter()
        .find(|item| sticker_matches(item, requested))
        .ok_or_else(|| ToolFailure::new("sticker_not_found", "character sticker was not found"))?;
    let id = required_id(&sticker, &["id"])?;
    core.request(
        Method::DELETE,
        &format!("/api/characters/{character}/stickers/{id}/"),
        None,
    )
    .await?;
    Ok(json!({"deleted":true,"sticker":sticker}))
}

fn sticker_matches(sticker: &Value, selector: &str) -> bool {
    let selector = selector.trim().to_lowercase();
    value_id(sticker.get("id"))
        .into_iter()
        .chain(
            sticker
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )
        .chain(
            sticker
                .get("aliases")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        )
        .any(|candidate| candidate.trim().to_lowercase() == selector)
}

fn sticker_part(sticker: &Value, character: &str) -> Result<Value, ToolFailure> {
    let id = required_id(sticker, &["id"])?;
    let name = required_text(sticker, "name")?;
    let url = sticker
        .get("image_url")
        .or_else(|| sticker.get("imageUrl"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_sticker", "sticker has no image URL"))?;
    let mime = sticker
        .get("mime")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("image/"))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            mime_guess::from_path(url)
                .first_or_octet_stream()
                .essence_str()
                .to_owned()
        });
    Ok(json!({
        "type":"sticker",
        "stickerId":json_id(&id),
        "characterId":json_id(character),
        "name":name,
        "url":url,
        "mime":mime,
        "alt":sticker.get("description").and_then(Value::as_str).unwrap_or(name),
    }))
}

async fn send_email(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let subject = required_text(args, "subject")?;
    let content = required_text(args, "content")?;
    let mut payload = json!({
        "subject":subject,
        "content":content,
        "html":args.get("html").and_then(Value::as_str).unwrap_or_default(),
    });
    let object = payload.as_object_mut().expect("email payload is an object");
    if let Some(to) = args.get("to").filter(|value| !value.is_null()) {
        object.insert("to".to_owned(), to.clone());
    }
    if let Some(request_id) = args.get("requestId").and_then(Value::as_str) {
        object.insert("request_id".to_owned(), json!(request_id));
    }
    core.request(
        Method::POST,
        "/api/agent/external-email/send/",
        Some(payload),
    )
    .await
}

async fn list_qq_bots(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let mut pairs = vec![(
        "owner_only",
        args.get("ownerOnly")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            .to_string(),
    )];
    if let Some(status) = args.get("status").and_then(Value::as_str) {
        pairs.push(("status", status.to_owned()));
    }
    core.request(
        Method::GET,
        &query_path("/api/devices/qq_bot/", &pairs),
        None,
    )
    .await
}

async fn qq_management(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let pairs = optional_id(args, &["botId"])?
        .map(|id| vec![("bot_id", id)])
        .unwrap_or_default();
    let raw = core
        .request(
            Method::GET,
            &query_path("/api/devices/qq_bot/management/", &pairs),
            None,
        )
        .await?;
    let data = raw.get("data").unwrap_or(&raw);
    let permissions = data.get("permissions").and_then(Value::as_object);
    let include_unapproved = args
        .get("includeUnapproved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let approved = |name: &str| {
        permissions
            .and_then(|value| value.get(name))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| {
                include_unapproved || item.get("approved").and_then(Value::as_bool) == Some(true)
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    Ok(json!({
        "botId":data.get("bot_id").or_else(|| data.get("default_bot_id")),
        "contacts":approved("allowed_contacts"),
        "groups":approved("allowed_groups"),
        "defaultTarget":default_qq_target(data),
        "raw":raw,
    }))
}

async fn read_qq(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let (bot, target_type, target, used_default, _) = qq_target(core, args).await?;
    let mut pairs = vec![
        ("target_type", target_type),
        ("target_qq_number", target),
        (
            "limit",
            args.get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(10)
                .clamp(1, 100)
                .to_string(),
        ),
    ];
    if let Some(before_id) = args.get("beforeId").and_then(Value::as_i64) {
        pairs.push(("before_id", before_id.to_string()));
    }
    let raw = core
        .request(
            Method::GET,
            &query_path(&format!("/api/devices/qq_bot/{bot}/messages/"), &pairs),
            None,
        )
        .await?;
    let data = raw.get("data").unwrap_or(&raw);
    let mut messages = data
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.reverse();
    Ok(json!({
        "botId":bot,
        "targetType":pairs[0].1.clone(),
        "targetQqNumber":pairs[1].1.clone(),
        "usedDefaultTarget":used_default,
        "messages":messages,
        "hasMore":data.get("has_more").and_then(Value::as_bool).unwrap_or(false),
        "nextBeforeId":data.get("next_before_id").cloned().unwrap_or(Value::Null),
        "synchronization":data.get("synchronization").cloned().unwrap_or_else(|| json!({})),
    }))
}

async fn send_qq(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", "content is required"))?;
    let (bot, target_type, target, used_default, management) = qq_target(core, args).await?;
    let mut raw = core
        .request(
            Method::POST,
            &format!("/api/devices/qq_bot/{bot}/send-message/"),
            Some(json!({
                "target_type":target_type,
                "target_qq_number":target,
                "content":content,
                "metadata":args.get("metadata").cloned().unwrap_or_else(|| json!({})),
                "request_id":args.get("requestId").cloned()
            })),
        )
        .await?;
    if let Some(value) = raw.as_object_mut() {
        value.insert(
            "resolved".to_owned(),
            json!({
                "botId":bot,
                "targetType":target_type,
                "targetQqNumber":target,
                "usedDefaultTarget":used_default,
                "management":management,
            }),
        );
    }
    Ok(raw)
}

async fn contact_user(core: &CoreClient, args: &Value) -> Result<Value, ToolFailure> {
    let message = args
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", "message is required"))?;
    let title = args.get("title").and_then(Value::as_str).unwrap_or("");
    let text = if title.is_empty() {
        message.to_owned()
    } else {
        format!("{title}\n\n{message}")
    };
    let channel = args
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    if !matches!(channel, "auto" | "qq" | "email" | "both") {
        return Err(ToolFailure::new(
            "invalid_arguments",
            "channel must be auto, qq, email, or both",
        ));
    }
    let mut attempts = Vec::new();
    let mut delivered = Vec::new();
    let source_type = args
        .get("sourceType")
        .and_then(Value::as_str)
        .or_else(|| {
            args.get("metadata")
                .and_then(|value| value.get("source_type"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .trim();
    let source_id = args
        .get("sourceId")
        .and_then(Value::as_str)
        .or_else(|| {
            args.get("metadata")
                .and_then(|value| value.get("source_id"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .trim();
    let mut metadata = args
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert("source".to_owned(), json!("contact_user"));
    metadata.insert(
        "source_type".to_owned(),
        json!(if source_type.is_empty() {
            "agent"
        } else {
            source_type
        }),
    );
    metadata.insert("source_id".to_owned(), json!(source_id));
    if matches!(channel, "auto" | "qq" | "both") {
        let request_id = channel_request_id(args, "qq", source_type, source_id);
        match send_qq(
            core,
            &json!({"content":text,"metadata":metadata,"requestId":request_id}),
        )
        .await
        {
            Ok(value) => {
                attempts.push(json!({"channel":"qq","success":true,"result":value}));
                delivered.push("qq");
            }
            Err(error) => {
                attempts.push(json!({"channel":"qq","success":false,"error":error.to_string()}))
            }
        }
    }
    if matches!(channel, "email" | "both") || (channel == "auto" && delivered.is_empty()) {
        let request_id = channel_request_id(args, "email", "", "");
        match core
            .request(
                Method::POST,
                "/api/agent/external-email/send/",
                Some(json!({
                    "subject":if title.is_empty() { "Eden Agent 提醒" } else { title },
                    "content":text,
                    "metadata":metadata,
                    "request_id":request_id,
                })),
            )
            .await
        {
            Ok(value) => {
                attempts.push(json!({"channel":"email","success":true,"result":value}));
                delivered.push("email");
            }
            Err(error) => {
                attempts.push(json!({"channel":"email","success":false,"error":error.to_string()}))
            }
        }
    }
    if delivered.is_empty() {
        return Err(ToolFailure::new(
            "delivery_failed",
            format!(
                "all notification channels failed: {}",
                Value::Array(attempts)
            ),
        ));
    }
    Ok(json!({
        "success":true,
        "requestedChannel":channel,
        "deliveredChannels":delivered,
        "attempts":attempts,
        "title":title,
        "message":message,
        "metadata":metadata,
        "allRequestedChannelsSucceeded":channel != "both" || delivered.len() == 2,
    }))
}

async fn qq_target(
    core: &CoreClient,
    args: &Value,
) -> Result<(String, String, String, bool, Value), ToolFailure> {
    let pairs = optional_id(args, &["botId"])?
        .map(|id| vec![("bot_id", id)])
        .unwrap_or_default();
    let management = core
        .request(
            Method::GET,
            &query_path("/api/devices/qq_bot/management/", &pairs),
            None,
        )
        .await?;
    let data = management.get("data").unwrap_or(&management);
    let bot = optional_id(args, &["botId"])?
        .or_else(|| value_id(data.get("bot_id").or_else(|| data.get("default_bot_id"))))
        .ok_or_else(|| ToolFailure::new("qq_not_configured", "no QQ bot is configured"))?;
    if let Some(target) = args
        .get("targetQqNumber")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let target_type = args
            .get("targetType")
            .and_then(Value::as_str)
            .unwrap_or("user");
        validate_qq_target(target_type, target)?;
        return Ok((
            bot,
            target_type.to_owned(),
            target.trim().to_owned(),
            false,
            management,
        ));
    }
    if let Some(target_type) = args.get("targetType").and_then(Value::as_str)
        && target_type != "user"
    {
        return Err(ToolFailure::new(
            "invalid_arguments",
            format!("发送到 {target_type} 时必须显式提供 targetQqNumber"),
        ));
    }
    let target = default_qq_target(data).ok_or_else(|| {
        ToolFailure::new(
            "qq_target_not_configured",
            "no default QQ delivery target or approved super administrator is configured",
        )
    })?;
    let number = target
        .get("target_qq_number")
        .or_else(|| target.get("qq_number"))
        .and_then(|value| value_id(Some(value)))
        .ok_or_else(|| ToolFailure::new("qq_target_not_configured", "target has no QQ number"))?;
    let target_type = target
        .get("target_type")
        .and_then(Value::as_str)
        .unwrap_or("user");
    validate_qq_target(target_type, &number)?;
    Ok((bot, target_type.to_owned(), number, true, management))
}

fn default_qq_target(data: &Value) -> Option<Value> {
    if let Some(target) = data
        .get("default_send_target")
        .filter(|value| value.is_object())
        && value_id(target.get("target_qq_number")).is_some_and(|value| !value.trim().is_empty())
    {
        return Some(target.clone());
    }
    data.get("permissions")
        .and_then(|value| value.get("allowed_contacts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|contact| {
            contact.get("approved").and_then(Value::as_bool) == Some(true)
                && contact.get("permission_level").and_then(Value::as_str)
                    == Some("super_admin")
        })
        .map(|contact| {
            json!({
                "target_type":"user",
                "target_qq_number":contact.get("target_qq_number").or_else(|| contact.get("qq_number")).or_else(|| contact.get("id")),
                "name":contact.get("name"),
                "permission_level":contact.get("permission_level"),
                "permission_label":contact.get("permission_label"),
            })
        })
}

fn validate_qq_target(target_type: &str, number: &str) -> Result<(), ToolFailure> {
    if !matches!(target_type, "user" | "group") {
        return Err(ToolFailure::new(
            "invalid_arguments",
            "targetType must be user or group",
        ));
    }
    let number = number.trim();
    if !(5..=20).contains(&number.len()) || !number.chars().all(|value| value.is_ascii_digit()) {
        return Err(ToolFailure::new(
            "invalid_arguments",
            "targetQqNumber must contain 5-20 digits",
        ));
    }
    Ok(())
}

fn channel_request_id(
    args: &Value,
    channel: &str,
    source_type: &str,
    source_id: &str,
) -> Option<String> {
    let base = args.get("requestId").and_then(Value::as_str)?.trim();
    if base.is_empty() {
        return None;
    }
    let mut parts = vec![base, channel];
    if !source_type.is_empty() {
        parts.push(source_type);
    }
    if !source_id.is_empty() {
        parts.push(source_id);
    }
    Some(parts.join("-"))
}

async fn character_id(
    host: &HostServices,
    args: &Value,
    session: Option<&str>,
) -> Result<String, ToolFailure> {
    let session = session.and_then(|value| value.parse::<SessionId>().ok());
    character_context(host, args, session)
        .await
        .map(|character| character.id)
}

async fn character_context(
    host: &HostServices,
    args: &Value,
    session: Option<SessionId>,
) -> Result<CharacterContext, ToolFailure> {
    let explicit = optional_id(args, &["characterId"])?;
    let record = match session {
        Some(session) => Some(host.store.get_session(session).await.map_err(store_error)?),
        None => None,
    };
    let participant = record.as_ref().and_then(|record| {
        record.participants.iter().find(|participant| {
            explicit
                .as_deref()
                .is_none_or(|id| value_id(participant.get("characterId")).as_deref() == Some(id))
        })
    });
    let profile_character = participant
        .and_then(|value| value.get("profile"))
        .and_then(|value| value.get("character"));
    let id = explicit
        .or_else(|| participant.and_then(|value| value_id(value.get("characterId"))))
        .or_else(|| profile_character.and_then(|value| value_id(value.get("id"))))
        .ok_or_else(|| ToolFailure::new("missing_character", "当前会话没有绑定角色"))?;
    let name = participant
        .and_then(|value| value.get("characterName"))
        .and_then(Value::as_str)
        .or_else(|| {
            profile_character
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .to_owned();
    let visual_preference = profile_character
        .and_then(|value| {
            value
                .get("visual_preference")
                .or_else(|| value.get("visualPreference"))
        })
        .and_then(Value::as_str)
        .unwrap_or("static")
        .to_owned();
    Ok(CharacterContext {
        id,
        name,
        visual_preference,
    })
}

async fn current_character_action(
    host: &HostServices,
    session: SessionId,
    character: &str,
) -> Result<Option<Value>, ToolFailure> {
    let events = host
        .store
        .list_events(session, 0)
        .await
        .map_err(store_error)?;
    Ok(events.into_iter().rev().find_map(|event| {
        if event.event_type != "character.action.changed" {
            return None;
        }
        let event_character = event
            .payload
            .get("characterId")
            .or_else(|| event.payload.get("characterID"))
            .and_then(|value| value_id(Some(value)));
        (event_character.as_deref() == Some(character)).then_some(event.payload)
    }))
}

fn participant_from_assistant(assistant: &Value) -> Value {
    let character = assistant
        .get("character")
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "assistantId":assistant.get("id").cloned().unwrap_or(Value::Null),
        "assistantName":assistant.get("name").and_then(Value::as_str).or_else(|| character.get("name").and_then(Value::as_str)).unwrap_or(""),
        "characterId":character.get("id").cloned(),
        "characterName":character.get("name").and_then(Value::as_str).unwrap_or(""),
        "signature":character.get("signature").and_then(Value::as_str).unwrap_or(""),
        "avatarUrl":character.get("avatar_url").and_then(Value::as_str).unwrap_or(""),
        "standingImageUrl":character.get("default_standing_image_url").and_then(Value::as_str).unwrap_or(""),
        "ttsConfigId":character.get("tts_config_id").cloned(),
        "position":0,
        "profile":assistant
    })
}

/// Keep the model-facing assistant catalog deliberately small and stable.
/// Mon Core assistant records contain full prompts, costumes and Spine assets;
/// those belong to the host/UI boundary and must never enter the model context.
fn assistant_tool_summary(assistant: &Value) -> Option<Value> {
    let id = assistant
        .get("id")
        .and_then(|value| value_id(Some(value)))?;
    let character = assistant.get("character").filter(|value| value.is_object());
    let character_id = character
        .and_then(|value| value.get("id"))
        .or_else(|| assistant.get("character_id"))
        .and_then(|value| value_id(Some(value)));
    let name = assistant
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| {
            character
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let name = bounded_tool_text(name, 120);
    let character_name = bounded_tool_text(
        character
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    );
    Some(json!({
        "id":json_id(&id),
        "name":name,
        "isDefault":assistant.get("is_default").and_then(Value::as_bool).unwrap_or(false),
        "character":{
            "id":character_id.as_deref().map(json_id),
            "name":character_name,
        }
    }))
}

fn bounded_tool_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn participant_tool_summary(participant: &Value) -> Value {
    json!({
        "assistantId":participant.get("assistantId").cloned().unwrap_or(Value::Null),
        "assistantName":participant.get("assistantName").and_then(Value::as_str).unwrap_or(""),
        "characterId":participant.get("characterId").cloned().unwrap_or(Value::Null),
        "characterName":participant.get("characterName").and_then(Value::as_str).unwrap_or(""),
    })
}

fn qq_target_properties() -> Value {
    json!({
        "botId":id_schema(),
        "targetType":{"type":"string","enum":["user","group"]},
        "targetQqNumber":{"type":"string","minLength":5,"maxLength":20}
    })
}

fn merge(left: Value, right: Value) -> Value {
    let mut map = left.as_object().cloned().unwrap_or_default();
    map.extend(right.as_object().cloned().unwrap_or_default());
    Value::Object(map)
}

fn normalize_keys(value: &Value, aliases: &[(&str, &str)]) -> Value {
    let mut map = value.as_object().cloned().unwrap_or_default();
    for (source, target) in aliases {
        if let Some(value) = map.remove(*source) {
            map.insert((*target).to_owned(), value);
        }
    }
    Value::Object(map)
}

fn array_results(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .cloned()
        .or_else(|| value.get("results").and_then(Value::as_array).cloned())
        .or_else(|| value.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn optional_id(args: &Value, names: &[&str]) -> Result<Option<String>, ToolFailure> {
    for name in names {
        if let Some(value) = value_id(args.get(*name)) {
            if !value.is_empty()
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            {
                return Ok(Some(value));
            }
            return Err(ToolFailure::new("invalid_id", format!("invalid {name}")));
        }
    }
    Ok(None)
}

fn required_id(args: &Value, names: &[&str]) -> Result<String, ToolFailure> {
    optional_id(args, names)?
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{} is required", names[0])))
}

fn required_text<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolFailure> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{name} is required")))
}

fn required_session(context: &ToolCallContext) -> Result<SessionId, ToolFailure> {
    context
        .session_id
        .as_deref()
        .ok_or_else(|| ToolFailure::new("missing_session", "该操作需要当前会话"))?
        .parse::<SessionId>()
        .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))
}

fn turn_id(context: &ToolCallContext) -> Option<TurnId> {
    context
        .metadata
        .get("turnId")
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn value_id(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn json_id(value: &str) -> Value {
    value
        .parse::<i64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(value.to_owned()))
}

fn query_path(path: &str, pairs: &[(&str, String)]) -> String {
    let mut url = Url::parse(&format!("http://local{path}")).expect("valid API path");
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            if !value.is_empty() {
                query.append_pair(key, value);
            }
        }
    }
    format!(
        "{}{}",
        url.path(),
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    )
}

fn store_error(error: impl std::fmt::Display) -> ToolFailure {
    ToolFailure::new("store_error", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::State,
        http::{Request, Response},
    };
    use eden_agent_blob::BlobService;
    use eden_agent_core::event_channel;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tokio_util::sync::CancellationToken;

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        method: String,
        path: String,
        body: Value,
    }

    type CapturedRequests = Arc<Mutex<Vec<CapturedRequest>>>;

    async fn fake_core(
        State(requests): State<CapturedRequests>,
        request: Request<Body>,
    ) -> Response<Body> {
        let (parts, body) = request.into_parts();
        let path = parts
            .uri
            .path_and_query()
            .map(|value| value.as_str().to_owned())
            .unwrap_or_default();
        let method = parts.method.to_string();
        let is_json = parts
            .headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/json"));
        let bytes = to_bytes(body, 1_048_576).await.expect("request body");
        let body = if bytes.is_empty() {
            Value::Null
        } else if is_json {
            serde_json::from_slice(&bytes).expect("JSON request")
        } else {
            Value::String(String::from_utf8_lossy(&bytes).into_owned())
        };
        requests.lock().await.push(CapturedRequest {
            method: method.clone(),
            path: path.clone(),
            body,
        });
        if path == "/api/characters/9/stickers/1/" && method == "DELETE" {
            return Response::builder()
                .status(204)
                .body(Body::empty())
                .expect("empty delete response");
        }
        let payload = if path.starts_with("/api/devices/qq_bot/management/") {
            json!({"success":true,"data":{
                "bot_id":7,
                "default_send_target":{"target_type":"user","target_qq_number":"123456","name":"主人"},
                "permissions":{"allowed_contacts":[],"allowed_groups":[]}
            }})
        } else if path.starts_with("/api/devices/qq_bot/7/messages/") {
            json!({"success":true,"data":{
                "messages":[
                    {"id":12,"role":"assistant","content":"我会记得。"},
                    {"id":11,"role":"user","content":"别忘了明天的事。"}
                ],
                "has_more":true,
                "next_before_id":11
            }})
        } else if path == "/api/devices/qq_bot/7/send-message/" {
            json!({"success":true,"data":{"queued":true,"request_id":"qq-send-test"}})
        } else if path == "/api/agent/external-email/send/" {
            json!({"sent":true,"to":["owner@example.test"]})
        } else if path == "/api/assistants/" {
            json!({"count":2,"results":[
                {
                    "id":2,
                    "name":"Assistant Two",
                    "is_default":true,
                    "devices":[{"id":1,"secret":"must-not-reach-model"}],
                    "character":{
                        "id":9,
                        "name":"Character Two",
                        "signature":"signature",
                        "avatar_url":"/media/avatar.png",
                        "system_prompt":"very large private prompt",
                        "costumes":[{"spine_assets":[{"atlas":"large"}]}]
                    }
                },
                {"id":3,"name":"Assistant Three","character":{"id":10,"name":"Character Three"}}
            ]})
        } else if path == "/api/assistants/2/" {
            json!({
                "id":2,
                "name":"Assistant Two",
                "character":{
                    "id":9,
                    "name":"Character Two",
                    "signature":"signature",
                    "avatar_url":"/media/avatar.png",
                    "default_standing_image_url":"/media/standing.png",
                    "tts_config_id":4
                }
            })
        } else if path == "/api/characters/9/visual-actions/" {
            json!([
                {"id":101,"name":"开心","intent":"happy","aliases":["高兴"],"static_image_url":"/media/actions/happy.png","enabled":true},
                {"id":102,"name":"思考","intent":"think","static_image_url":"/media/actions/think.png","enabled":true}
            ])
        } else if path.starts_with("/api/characters/9/stickers/") && method == "GET" {
            json!([{
                "id":1,"character":9,"name":"开心","description":"露出开心笑容",
                "emotion":"开心","intent":"表达喜悦","aliases":["高兴"],
                "image_url":"http://core.test/media/happy.webp","mime":"image/webp"
            }])
        } else if path == "/api/characters/9/stickers/" && method == "POST" {
            json!({
                "id":2,"character":9,"name":"新贴纸","description":"语义描述",
                "emotion":"开心","intent":"表达喜悦","aliases":["新图"],
                "image_url":"http://core.test/media/new.png","mime":"image/png"
            })
        } else {
            json!({"detail":"not found"})
        };
        Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .expect("response")
    }

    async fn fake_host() -> (HostServices, CapturedRequests, tokio::task::JoinHandle<()>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let application = Router::new()
            .fallback(fake_core)
            .with_state(requests.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, application).await.expect("fake core");
        });
        let store = eden_agent_store::Store::in_memory().await.expect("store");
        let host = HostServices::new(
            store,
            Some(&format!("http://{address}/")),
            Some("test-token"),
        )
        .expect("host");
        (host, requests, task)
    }

    fn context(
        session: Option<SessionId>,
        turn: Option<TurnId>,
        metadata: Value,
    ) -> ToolCallContext {
        let (events, _receiver) = event_channel(8);
        let mut metadata = metadata.as_object().cloned().unwrap_or_default();
        if let Some(turn) = turn {
            metadata.insert("turnId".to_owned(), json!(turn));
        }
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: session.map(|value| value.to_string()),
            metadata: Value::Object(metadata),
        }
    }

    #[test]
    fn core_tool_contracts_are_strict() {
        for action in Action::ALL {
            let schema = parameters(action);
            assert_eq!(schema["type"], "object", "{}", action.name());
            assert_eq!(
                schema["additionalProperties"],
                false,
                "{} must reject unknown arguments",
                action.name()
            );
        }
        let visual = parameters(Action::SwitchVisual);
        assert_eq!(
            visual["required"],
            json!(["立绘动作", "表情符号", "立绘动效"])
        );
        assert_eq!(
            visual["properties"]
                .as_object()
                .expect("visual properties")
                .len(),
            3
        );
        let switch = parameters(Action::SwitchAssistant);
        assert_eq!(switch["required"], json!([]));
        assert!(switch["properties"].get("assistantId").is_some());
        assert!(switch["properties"].get("assistantName").is_some());
        assert!(
            Action::SwitchAssistant
                .description()
                .contains("叫某助手出来")
        );
        assert!(Action::SwitchAssistant.description().contains("必须调用"));
    }

    #[tokio::test]
    async fn assistant_catalog_and_switch_outputs_exclude_full_core_profiles() {
        let (host, _requests, server) = fake_host().await;
        let list = CoreTool {
            host: host.clone(),
            action: Action::ListAssistants,
        };
        let listed = list
            .execute(
                &ToolCall {
                    id: "list-assistants".to_owned(),
                    name: Action::ListAssistants.name().to_owned(),
                    arguments: json!({}),
                },
                context(None, None, json!({})),
            )
            .await
            .expect("list assistants")
            .structured_content
            .expect("structured list");
        assert_eq!(listed["count"], 2);
        assert_eq!(listed["assistants"][0]["character"]["id"], 9);
        let serialized = listed.to_string();
        assert!(!serialized.contains("system_prompt"));
        assert!(!serialized.contains("costumes"));
        assert!(!serialized.contains("devices"));

        let session = host
            .store
            .create_session_with_participants(
                "assistant switch output",
                vec![json!({"assistantId":1,"assistantName":"Assistant One"})],
            )
            .await
            .expect("session");
        let switched = CoreTool {
            host: host.clone(),
            action: Action::SwitchAssistant,
        }
        .execute(
            &ToolCall {
                id: "switch-assistant".to_owned(),
                name: Action::SwitchAssistant.name().to_owned(),
                arguments: json!({"assistantId":2}),
            },
            context(Some(session.id), Some(TurnId::new()), json!({})),
        )
        .await
        .expect("switch assistant")
        .structured_content
        .expect("structured switch");
        assert_eq!(switched["assistant"]["id"], 2);
        assert!(switched["participant"].get("profile").is_none());
        assert!(switched.to_string().len() < 2_000);

        let session = host
            .store
            .create_session_with_participants(
                "assistant switch by character name",
                vec![json!({"assistantId":1,"assistantName":"Assistant One"})],
            )
            .await
            .expect("session");
        let switched = CoreTool {
            host,
            action: Action::SwitchAssistant,
        }
        .execute(
            &ToolCall {
                id: "switch-assistant-by-name".to_owned(),
                name: Action::SwitchAssistant.name().to_owned(),
                arguments: json!({"assistantName":"Character Two"}),
            },
            context(Some(session.id), Some(TurnId::new()), json!({})),
        )
        .await
        .expect("switch assistant by name")
        .structured_content
        .expect("structured name switch");
        assert_eq!(switched["assistant"]["id"], 2);
        server.abort();
    }

    #[tokio::test]
    async fn mutating_core_tools_are_sequential_and_every_core_tool_has_a_timeout() {
        let store = eden_agent_store::Store::in_memory().await.expect("store");
        let host = HostServices::new(store, None, None).expect("host");
        for action in Action::ALL {
            let tool = CoreTool {
                host: host.clone(),
                action,
            };
            assert!(
                tool.timeout().is_some(),
                "{} needs a timeout",
                action.name()
            );
            assert_eq!(
                tool.definition().execution_mode == ToolExecutionMode::Sequential,
                action.mutates(),
                "{} execution mode",
                action.name()
            );
        }
    }

    #[test]
    fn performance_and_sticker_selectors_match_the_archived_behavior() {
        assert_eq!(
            performance_choice(&json!({"立绘动效":"左右摇晃"}), "立绘动效", MOTION_CODES)
                .expect("motion"),
            ("左右摇晃", "shake")
        );
        assert!(
            performance_choice(&json!({"立绘动效":"shake"}), "立绘动效", MOTION_CODES).is_err()
        );
        let action = json!({"id":101,"name":"开心","intent":"happy","aliases":["高兴"]});
        assert!(action_matches(&action, "高兴"));
        let sticker = json!({"id":7,"name":"委屈大哭","aliases":["哭哭"]});
        assert!(sticker_matches(&sticker, "哭哭"));
        assert!(sticker_matches(&sticker, "7"));
    }

    #[test]
    fn notification_ids_are_channel_scoped_and_permission_patterns_hide_content() {
        let args = json!({"requestId":"awake-job-1","message":"secret body"});
        assert_eq!(
            channel_request_id(&args, "qq", "memo", "42").as_deref(),
            Some("awake-job-1-qq-memo-42")
        );
        assert_eq!(
            channel_request_id(&args, "email", "", "").as_deref(),
            Some("awake-job-1-email")
        );
        let patterns = permission_patterns(Action::ContactUser, &args);
        assert!(!patterns.join(" ").contains("secret body"));
    }

    #[test]
    fn qq_target_validation_and_default_resolution_are_safe() {
        assert!(validate_qq_target("user", "123456").is_ok());
        assert!(validate_qq_target("group", "987654321").is_ok());
        assert!(validate_qq_target("channel", "123456").is_err());
        assert!(validate_qq_target("user", "12/../../etc").is_err());
        let target = default_qq_target(&json!({
            "permissions":{"allowed_contacts":[
                {"approved":true,"permission_level":"super_admin","qq_number":"123456"}
            ]}
        }))
        .expect("super administrator target");
        assert_eq!(target["target_qq_number"], "123456");
    }

    #[tokio::test]
    async fn current_action_is_read_from_the_durable_session_event_stream() {
        let store = eden_agent_store::Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_participants(
                "character",
                vec![json!({"assistantId":3,"characterId":9,"characterName":"江梦晚"})],
            )
            .await
            .expect("session");
        let turn = TurnId::new();
        store
            .append_event(
                session.id,
                Some(turn),
                "character.action.changed",
                json!({"characterId":9,"action":{"id":102,"name":"思考"}}),
            )
            .await
            .expect("event");
        let host = HostServices::new(store, None, None).expect("host");
        let current = current_character_action(&host, session.id, "9")
            .await
            .expect("current")
            .expect("action");
        assert_eq!(current["action"]["name"], "思考");
    }

    #[tokio::test]
    async fn assistant_switch_schedules_a_durable_next_root_run_handoff() {
        let (host, requests, server) = fake_host().await;
        let session = host
            .store
            .create_session_with_participants(
                "assistant switch",
                vec![json!({"assistantId":1,"assistantName":"Assistant One","position":0})],
            )
            .await
            .expect("session");
        let tool = CoreTool {
            host: host.clone(),
            action: Action::SwitchAssistant,
        };
        let turn = TurnId::new();
        let output = tool
            .execute(
                &ToolCall {
                    id: "switch-assistant".to_owned(),
                    name: Action::SwitchAssistant.name().to_owned(),
                    arguments: json!({"assistantId":2}),
                },
                context(Some(session.id), Some(turn), json!({})),
            )
            .await
            .expect("switch assistant");
        let structured = output.structured_content.expect("structured");
        assert_eq!(structured["participant"]["assistantId"], 2);
        assert_eq!(structured["effectiveFrom"], "next_root_run");
        assert_eq!(structured["status"], "scheduled");
        let unchanged = host.store.get_session(session.id).await.expect("session");
        assert_eq!(unchanged.participants[0]["assistantId"], 1);
        let jobs = host
            .store
            .list_jobs(Some("assistant.handoff"), 10)
            .await
            .expect("handoff jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].payload["participant"]["assistantId"], 2);
        let events = host.store.list_events(session.id, 0).await.expect("events");
        assert!(events.iter().any(|event| {
            event.turn_id == Some(turn) && event.event_type == "session.assistant_handoff.requested"
        }));
        assert!(
            requests
                .lock()
                .await
                .iter()
                .any(|request| request.method == "GET" && request.path == "/api/assistants/2/")
        );

        let error = tool
            .execute(
                &ToolCall {
                    id: "busy-switch".to_owned(),
                    name: Action::SwitchAssistant.name().to_owned(),
                    arguments: json!({"assistantId":2}),
                },
                context(Some(session.id), None, json!({})),
            )
            .await
            .expect_err("switching outside an active turn must fail");
        assert_eq!(error.info.code, "missing_turn");
        server.abort();
    }

    #[tokio::test]
    async fn attachment_reference_reads_the_current_message_blob() {
        let directory = tempfile::tempdir().expect("directory");
        let store = eden_agent_store::Store::in_memory().await.expect("store");
        let blobs = BlobService::new(directory.path(), store.clone(), 1024)
            .await
            .expect("blobs");
        let image = b"not-a-real-png-but-an-image-payload";
        let record = blobs.put("image/png", image).await.expect("blob");
        let host = HostServices::new(store, None, None)
            .expect("host")
            .with_blob_service(blobs);
        let core =
            CoreClient::new(reqwest::Client::new(), "http://127.0.0.1:1/", "token").expect("core");
        let context = context(
            None,
            None,
            json!({"attachments":[{"blobId":record.id,"filename":"哭哭.png","mime":"image/png"}]}),
        );
        let (bytes, mime, filename) = read_sticker_image(
            &host,
            &core,
            &context,
            "attachment://%E5%93%AD%E5%93%AD.png",
        )
        .await
        .expect("attachment");
        assert_eq!(bytes, image);
        assert_eq!(mime, "image/png");
        assert_eq!(filename, "哭哭.png");
    }

    #[tokio::test]
    async fn qq_defaults_history_order_and_notification_channel_ids_are_preserved() {
        let (host, requests, server) = fake_host().await;
        let send = CoreTool {
            host: host.clone(),
            action: Action::SendQqMessage,
        };
        let sent = send
            .execute(
                &ToolCall {
                    id: "send".to_owned(),
                    name: Action::SendQqMessage.name().to_owned(),
                    arguments: json!({"content":"测试消息"}),
                },
                context(None, None, json!({"operationId":"awake-job-1"})),
            )
            .await
            .expect("QQ send");
        assert_eq!(sent.details["resolved"]["usedDefaultTarget"], true);

        let read = CoreTool {
            host: host.clone(),
            action: Action::ReadQqMessages,
        };
        let history = read
            .execute(
                &ToolCall {
                    id: "read".to_owned(),
                    name: Action::ReadQqMessages.name().to_owned(),
                    arguments: json!({"limit":20}),
                },
                context(None, None, json!({})),
            )
            .await
            .expect("QQ history");
        assert_eq!(history.details["messages"][0]["id"], 11);
        assert_eq!(history.details["messages"][1]["id"], 12);
        assert_eq!(history.details["hasMore"], true);

        let contact = CoreTool {
            host,
            action: Action::ContactUser,
        };
        let delivered = contact
            .execute(
                &ToolCall {
                    id: "notify".to_owned(),
                    name: Action::ContactUser.name().to_owned(),
                    arguments: json!({"message":"普通提醒","channel":"auto"}),
                },
                context(None, None, json!({"operationId":"awake-job-2"})),
            )
            .await
            .expect("contact user");
        assert_eq!(delivered.details["deliveredChannels"], json!(["qq"]));

        let captured = requests.lock().await.clone();
        let sends = captured
            .iter()
            .filter(|request| request.path == "/api/devices/qq_bot/7/send-message/")
            .collect::<Vec<_>>();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0].body["request_id"], "awake-job-1-qq");
        assert_eq!(sends[0].body["target_qq_number"], "123456");
        assert_eq!(sends[1].body["request_id"], "awake-job-2-qq");
        assert_eq!(sends[1].body["metadata"]["source"], "contact_user");
        assert!(captured.iter().any(|request| {
            request.method == "GET"
                && request.path.contains("limit=20")
                && request.path.contains("target_qq_number=123456")
        }));
        server.abort();
    }

    #[tokio::test]
    async fn explicit_email_notification_does_not_attempt_qq() {
        let (host, requests, server) = fake_host().await;
        let contact = CoreTool {
            host,
            action: Action::ContactUser,
        };
        let delivered = contact
            .execute(
                &ToolCall {
                    id: "notify".to_owned(),
                    name: Action::ContactUser.name().to_owned(),
                    arguments: json!({"title":"重要","message":"事件","channel":"email"}),
                },
                context(None, None, json!({"operationId":"awake-job-3"})),
            )
            .await
            .expect("email contact");
        assert_eq!(delivered.details["deliveredChannels"], json!(["email"]));
        let captured = requests.lock().await.clone();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].path, "/api/agent/external-email/send/");
        assert_eq!(captured[0].body["request_id"], "awake-job-3-email");
        assert_eq!(captured[0].body["subject"], "重要");
        assert_eq!(captured[0].body["content"], "重要\n\n事件");
        server.abort();
    }

    #[tokio::test]
    async fn character_performance_is_rich_durable_and_can_keep_the_current_image() {
        let (host, _requests, server) = fake_host().await;
        let session = host
            .store
            .create_session_with_participants(
                "character",
                vec![json!({
                    "assistantId":3,
                    "characterId":9,
                    "characterName":"江梦晚",
                    "profile":{"character":{"id":9,"name":"江梦晚","visual_preference":"static"}}
                })],
            )
            .await
            .expect("session");
        let tool = CoreTool {
            host: host.clone(),
            action: Action::SwitchVisual,
        };
        let first_turn = TurnId::new();
        let first = tool
            .execute(
                &ToolCall {
                    id: "visual-1".to_owned(),
                    name: Action::SwitchVisual.name().to_owned(),
                    arguments: json!({
                        "立绘动作":"开心",
                        "表情符号":"爱心",
                        "立绘动效":"上下跳动"
                    }),
                },
                context(Some(session.id), Some(first_turn), json!({})),
            )
            .await
            .expect("first performance");
        assert_eq!(
            first.details["state"]["imageUrl"],
            "/media/actions/happy.png"
        );
        assert_eq!(first.details["state"]["motion"], "jump");
        assert_eq!(first.details["state"]["effect"], "heart");

        let second_turn = TurnId::new();
        let second = tool
            .execute(
                &ToolCall {
                    id: "visual-2".to_owned(),
                    name: Action::SwitchVisual.name().to_owned(),
                    arguments: json!({
                        "立绘动作":"保持当前",
                        "表情符号":"汗滴",
                        "立绘动效":"左右摇晃"
                    }),
                },
                context(Some(session.id), Some(second_turn), json!({})),
            )
            .await
            .expect("performance only");
        assert_eq!(second.details["state"]["action"]["intent"], "happy");
        assert_eq!(
            second.details["state"]["imageUrl"],
            "/media/actions/happy.png"
        );
        assert_eq!(second.details["state"]["motion"], "shake");
        assert_eq!(second.details["state"]["effect"], "sweat");

        let events = host.store.list_events(session.id, 0).await.expect("events");
        let actions = events
            .iter()
            .filter(|event| event.event_type == "character.action.changed")
            .collect::<Vec<_>>();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].turn_id, Some(first_turn));
        assert_eq!(actions[1].turn_id, Some(second_turn));
        assert_eq!(actions[1].payload["characterId"], 9);
        assert_eq!(actions[1].payload["characterName"], "江梦晚");
        assert_eq!(actions[1].payload["effectAnchor"], "head_right");
        assert!(
            actions[1].payload["performanceID"]
                .as_str()
                .is_some_and(|value| value.starts_with("perf_"))
        );
        server.abort();
    }

    #[tokio::test]
    async fn sticker_record_send_and_delete_use_semantics_aliases_and_structured_parts() {
        let (host, requests, server) = fake_host().await;
        let session = host
            .store
            .create_session_with_participants(
                "stickers",
                vec![json!({"assistantId":3,"characterId":9,"characterName":"江梦晚"})],
            )
            .await
            .expect("session");
        let remember = CoreTool {
            host: host.clone(),
            action: Action::RememberSticker,
        };
        let recorded = remember
            .execute(
                &ToolCall {
                    id: "remember".to_owned(),
                    name: Action::RememberSticker.name().to_owned(),
                    arguments: json!({
                        "imageUrl":"data:image/png;base64,aW1hZ2U=",
                        "name":"新贴纸",
                        "description":"语义描述",
                        "emotion":"开心",
                        "intent":"表达喜悦",
                        "aliases":["新图"]
                    }),
                },
                context(Some(session.id), Some(TurnId::new()), json!({})),
            )
            .await
            .expect("remember sticker");
        assert_eq!(recorded.details["name"], "新贴纸");

        let turn = TurnId::new();
        let send = CoreTool {
            host: host.clone(),
            action: Action::SendSticker,
        };
        let sent = send
            .execute(
                &ToolCall {
                    id: "send".to_owned(),
                    name: Action::SendSticker.name().to_owned(),
                    arguments: json!({"sticker":"高兴"}),
                },
                context(Some(session.id), Some(turn), json!({})),
            )
            .await
            .expect("send sticker");
        assert_eq!(sent.details["part"]["type"], "sticker");
        assert_eq!(sent.details["part"]["stickerId"], 1);
        assert_eq!(sent.details["part"]["characterId"], 9);
        assert_eq!(
            sent.details["part"]["url"],
            "http://core.test/media/happy.webp"
        );

        let delete = CoreTool {
            host: host.clone(),
            action: Action::DeleteSticker,
        };
        let deleted = delete
            .execute(
                &ToolCall {
                    id: "delete".to_owned(),
                    name: Action::DeleteSticker.name().to_owned(),
                    arguments: json!({"sticker":"高兴"}),
                },
                context(Some(session.id), Some(TurnId::new()), json!({})),
            )
            .await
            .expect("delete sticker");
        assert_eq!(deleted.details["deleted"], true);

        let events = host.store.list_events(session.id, 0).await.expect("events");
        let event = events
            .iter()
            .find(|event| event.event_type == "character.sticker.sent")
            .expect("sticker event");
        assert_eq!(event.turn_id, Some(turn));
        assert_eq!(event.payload["part"], sent.details["part"]);

        let captured = requests.lock().await.clone();
        let upload = captured
            .iter()
            .find(|request| {
                request.method == "POST" && request.path == "/api/characters/9/stickers/"
            })
            .expect("multipart upload");
        let multipart = upload.body.as_str().expect("multipart body");
        assert!(multipart.contains("新贴纸"));
        assert!(multipart.contains("语义描述"));
        assert!(captured.iter().any(|request| {
            request.method == "DELETE" && request.path == "/api/characters/9/stickers/1/"
        }));
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires real Core credentials, character ID, and sticker image"]
    async fn real_core_sticker_round_trip_cleans_up_its_artifact() {
        let base = std::env::var("MON_TEST_CORE_BASE_URL").expect("MON_TEST_CORE_BASE_URL");
        let token = std::env::var("MON_TEST_CORE_TOKEN").expect("MON_TEST_CORE_TOKEN");
        let character_id =
            std::env::var("MON_TEST_CORE_CHARACTER_ID").unwrap_or_else(|_| "4".to_owned());
        let image_path =
            std::env::var("MON_TEST_CORE_STICKER_IMAGE").expect("MON_TEST_CORE_STICKER_IMAGE");
        assert!(
            PathBuf::from(&image_path).is_absolute(),
            "MON_TEST_CORE_STICKER_IMAGE must be absolute"
        );
        let store = eden_agent_store::Store::in_memory().await.expect("store");
        let host = HostServices::new(store, Some(&base), Some(&token)).expect("host");
        let session = host
            .store
            .create_session_with_participants(
                "real Core sticker acceptance",
                vec![json!({
                    "assistantId":"real-core-test",
                    "characterId":character_id,
                    "characterName":"real Core test"
                })],
            )
            .await
            .expect("session");
        let name = format!("Eden Agent迁移验收临时贴纸-{}", now_millis());
        let mut created_id = None;
        let outcome: Result<(), String> = async {
            let recorded = CoreTool {
                host: host.clone(),
                action: Action::RememberSticker,
            }
            .execute(
                &ToolCall {
                    id: "real-core-remember".to_owned(),
                    name: Action::RememberSticker.name().to_owned(),
                    arguments: json!({
                        "imageUrl":image_path,
                        "name":name,
                        "description":"Eden Agent 全 Rust 迁移验收临时图片",
                        "emotion":"测试",
                        "intent":"验证贴纸创建发送删除链路",
                        "aliases":["Eden Agent迁移验收临时别名"]
                    }),
                },
                context(Some(session.id), Some(TurnId::new()), json!({})),
            )
            .await
            .map_err(|error| error.to_string())?;
            created_id =
                Some(required_id(&recorded.details, &["id"]).map_err(|error| error.to_string())?);

            let turn = TurnId::new();
            CoreTool {
                host: host.clone(),
                action: Action::SendSticker,
            }
            .execute(
                &ToolCall {
                    id: "real-core-send".to_owned(),
                    name: Action::SendSticker.name().to_owned(),
                    arguments: json!({"sticker":name}),
                },
                context(Some(session.id), Some(turn), json!({})),
            )
            .await
            .map_err(|error| error.to_string())?;

            CoreTool {
                host: host.clone(),
                action: Action::DeleteSticker,
            }
            .execute(
                &ToolCall {
                    id: "real-core-delete".to_owned(),
                    name: Action::DeleteSticker.name().to_owned(),
                    arguments: json!({"sticker":name}),
                },
                context(Some(session.id), Some(TurnId::new()), json!({})),
            )
            .await
            .map_err(|error| error.to_string())?;
            created_id = None;

            let events = host
                .store
                .list_events(session.id, 0)
                .await
                .map_err(|error| error.to_string())?;
            if !events.iter().any(|event| {
                event.turn_id == Some(turn) && event.event_type == "character.sticker.sent"
            }) {
                return Err("real Core sticker send did not persist its canonical event".to_owned());
            }
            Ok(())
        }
        .await;

        if let Some(id) = created_id
            && let Some(core) = host.core_client(None).await
        {
            let _ = core
                .request(
                    Method::DELETE,
                    &format!("/api/characters/{character_id}/stickers/{id}/"),
                    None,
                )
                .await;
        }
        assert!(outcome.is_ok(), "{}", outcome.unwrap_err());
    }

    fn require_real_external_send_consent(channel: &str) {
        const CONSENT: &str = "I_UNDERSTAND_THIS_SENDS_A_REAL_MESSAGE";
        assert_eq!(
            std::env::var("MON_TEST_ALLOW_EXTERNAL_SEND").as_deref(),
            Ok(CONSENT),
            "real {channel} acceptance sends an irreversible external message; set \
             MON_TEST_ALLOW_EXTERNAL_SEND={CONSENT} only after the destination is verified"
        );
    }

    #[tokio::test]
    #[ignore = "sends one real email; requires explicit consent and a configured Core email account"]
    async fn real_core_email_delivery_is_confirmed_by_the_transport() {
        require_real_external_send_consent("email");
        let base = std::env::var("MON_TEST_CORE_BASE_URL").expect("MON_TEST_CORE_BASE_URL");
        let token = std::env::var("MON_TEST_CORE_TOKEN").expect("MON_TEST_CORE_TOKEN");
        let recipient =
            std::env::var("MON_TEST_EMAIL_TO").expect("MON_TEST_EMAIL_TO must be verified");
        assert!(
            recipient.contains('@') && !recipient.contains(',') && !recipient.contains(';'),
            "MON_TEST_EMAIL_TO must contain exactly one email address"
        );
        let request_id = format!("edenagent-real-email-{}", now_millis());
        let host = HostServices::new(
            eden_agent_store::Store::in_memory().await.expect("store"),
            Some(&base),
            Some(&token),
        )
        .expect("host");
        let delivered = CoreTool {
            host,
            action: Action::SendEmail,
        }
        .execute(
            &ToolCall {
                id: "real-core-email".to_owned(),
                name: Action::SendEmail.name().to_owned(),
                arguments: json!({
                    "subject":"Eden Agent 全 Rust 迁移验收",
                    "content":format!("这是一封 Eden Agent 自动化迁移验收邮件。request_id={request_id}"),
                    "to":[recipient],
                    "requestId":request_id,
                }),
            },
            context(None, None, json!({})),
        )
        .await
        .expect("real email transport must accept and send the message");
        assert_eq!(delivered.details["request_id"], request_id);
        assert!(
            delivered.details["rejected"]
                .as_object()
                .is_none_or(serde_json::Map::is_empty),
            "SMTP transport rejected at least one recipient: {}",
            delivered.details
        );
    }

    #[tokio::test]
    #[ignore = "sends one real QQ message; requires explicit consent, an online bot, and an approved target"]
    async fn real_core_qq_delivery_requires_a_confirmed_bot_ack() {
        require_real_external_send_consent("QQ");
        let base = std::env::var("MON_TEST_CORE_BASE_URL").expect("MON_TEST_CORE_BASE_URL");
        let token = std::env::var("MON_TEST_CORE_TOKEN").expect("MON_TEST_CORE_TOKEN");
        let bot_id = std::env::var("MON_TEST_QQ_BOT_ID").expect("MON_TEST_QQ_BOT_ID");
        let target_type =
            std::env::var("MON_TEST_QQ_TARGET_TYPE").unwrap_or_else(|_| "user".to_owned());
        let target = std::env::var("MON_TEST_QQ_TARGET").expect("MON_TEST_QQ_TARGET");
        validate_qq_target(&target_type, &target).expect("verified QQ target");
        let request_id = format!("edenagent-real-qq-{}", now_millis());
        let host = HostServices::new(
            eden_agent_store::Store::in_memory().await.expect("store"),
            Some(&base),
            Some(&token),
        )
        .expect("host");
        let delivered = CoreTool {
            host,
            action: Action::SendQqMessage,
        }
        .execute(
            &ToolCall {
                id: "real-core-qq".to_owned(),
                name: Action::SendQqMessage.name().to_owned(),
                arguments: json!({
                    "botId":bot_id,
                    "targetType":target_type,
                    "targetQqNumber":target,
                    "content":format!("Eden Agent 全 Rust 迁移自动验收消息（{request_id}）"),
                    "metadata":{"source":"migration_acceptance"},
                    "requestId":request_id,
                }),
            },
            context(None, None, json!({})),
        )
        .await
        .expect("real QQ transport must accept the approved target");
        assert_eq!(delivered.details["data"]["request_id"], request_id);
        assert_eq!(
            delivered.details["data"]["delivery"]["confirmed"], true,
            "QQ delivery was queued but the BotCore/NapCat acknowledgement was not confirmed: {}",
            delivered.details
        );
        assert_eq!(delivered.details["data"]["access"]["approved"], true);
    }
}
