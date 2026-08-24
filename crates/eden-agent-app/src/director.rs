use eden_agent_core::{
    ContentBlock, Message, ModelAdapter, ModelRequest, ModelSpec, event_channel,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DIRECTOR_PROMPT: &str = "你是多人智能体会话的隐藏导演，负责判断场景、制定协作策略并编排发言节拍；不直接回答用户，也不要输出思维过程。先综合当前消息、最近公开对话和附件摘要判断场景，不能只按关键词分类。scene.domain 使用 social、coding、game、daily、research、mixed 或 general；scene.interactionType 使用 conversation、task 或 mixed；confidence 是 0 到 1。execution.mode 使用 solo、lead_support 或 ensemble。执行型任务通常需要明确负责人，社交互动才适合多人自然接话；不要为了展示角色而增加无意义节拍。每轮安排 1 到 5 个节拍，每位助手最多出现 2 次；禁止同一助手连续发言。用户明确要求所有参与者发言时，应在上限内覆盖全部参与者。addressTo 使用 user 或 assistant:<assistantID>，replyToBeat 只能引用更早节拍。speechAct 使用 respond、react、support、challenge、continue 或 close。只输出严格 JSON。";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectorBeat {
    #[serde(rename = "assistantID", alias = "assistantId")]
    pub assistant_id: Value,
    pub intent: String,
    pub speech_act: String,
    pub address_to: String,
    pub reply_to_beat: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectorScene {
    pub domain: String,
    pub interaction_type: String,
    pub confidence: f64,
    pub summary: String,
}

impl Default for DirectorScene {
    fn default() -> Self {
        Self {
            domain: "general".to_owned(),
            interaction_type: "conversation".to_owned(),
            confidence: 0.0,
            summary: "当前对话".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectorExecution {
    pub mode: String,
    #[serde(rename = "leadAssistantID", alias = "leadAssistantId")]
    pub lead_assistant_id: Option<Value>,
    #[serde(rename = "toolOwnerAssistantID", alias = "toolOwnerAssistantId")]
    pub tool_owner_assistant_id: Option<Value>,
    pub observation_strategy: String,
}

impl Default for DirectorExecution {
    fn default() -> Self {
        Self {
            mode: "solo".to_owned(),
            lead_assistant_id: None,
            tool_owner_assistant_id: None,
            observation_strategy: "on_demand".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectorPlan {
    #[serde(rename = "planID")]
    pub plan_id: String,
    pub beats: Vec<DirectorBeat>,
    pub source: String,
    pub diagnostic: Option<String>,
    pub scene: DirectorScene,
    pub execution: DirectorExecution,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlan {
    #[serde(default)]
    scene: Option<DirectorScene>,
    #[serde(default)]
    execution: Option<DirectorExecution>,
    #[serde(default, alias = "turns")]
    beats: Vec<RawBeat>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBeat {
    #[serde(
        default,
        rename = "assistantID",
        alias = "assistantId",
        alias = "assistant_id",
        alias = "assistant",
        alias = "name"
    )]
    assistant_id: Value,
    #[serde(default)]
    intent: String,
    #[serde(default, alias = "speech_act")]
    speech_act: String,
    #[serde(default, alias = "address_to")]
    address_to: String,
    #[serde(default, alias = "reply_to_beat")]
    reply_to_beat: Option<i64>,
}

pub(crate) struct DirectorRequest<'a> {
    pub(crate) model: Arc<dyn ModelAdapter>,
    pub(crate) model_spec: &'a ModelSpec,
    pub(crate) session_id: &'a str,
    pub(crate) user_text: &'a str,
    pub(crate) participants: &'a [Value],
    pub(crate) conversation_context: &'a str,
    pub(crate) attachment_context: &'a str,
    pub(crate) cancellation: CancellationToken,
}

pub(crate) async fn create_plan(request: DirectorRequest<'_>) -> DirectorPlan {
    let DirectorRequest {
        model,
        model_spec,
        session_id,
        user_text,
        participants,
        conversation_context,
        attachment_context,
        cancellation,
    } = request;
    let fallback = fallback_plan(user_text, participants);
    if participants.len() <= 1 {
        return DirectorPlan {
            source: "single".to_owned(),
            ..fallback
        };
    }
    let roster = participants
        .iter()
        .filter_map(|participant| {
            Some(json!({
                "assistantID": participant_id(participant)?,
                "name": participant_name(participant),
                "signature": participant_text(participant, "signature").unwrap_or_default(),
            }))
        })
        .collect::<Vec<_>>();
    let request = ModelRequest {
        model: model_spec.clone(),
        system_prompt: DIRECTOR_PROMPT.to_owned(),
        messages: vec![Message::user(
            json!({
                "participants":roster,
                "recentConversation":conversation_context,
                "userMessage":user_text,
                "attachmentContext":attachment_context,
            })
            .to_string(),
        )],
        tools: Vec::new(),
        session_id: Some(session_id.to_owned()),
        metadata: json!({"purpose":"companion_director"}),
    };
    let (emitter, mut events) = event_channel(128);
    let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
    let output = model.generate(request, emitter, cancellation).await;
    let _ = drain.await;
    let output = match output {
        Ok(output) => output,
        Err(_) => return fallback_with(fallback, "director_request_failed"),
    };
    if output.message.content.iter().any(
        |block| matches!(block, ContentBlock::Thinking { thinking, .. } if !thinking.trim().is_empty()),
    ) {
        return fallback_with(fallback, "director_reasoning_not_disabled");
    }
    let text = output
        .message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let Some(raw) = parse_raw_plan(&text) else {
        return fallback_with(fallback, "director_output_invalid_json");
    };
    normalize_plan(raw, participants)
        .unwrap_or_else(|| fallback_with(fallback, "director_output_no_valid_beats"))
}

pub(crate) fn actor_task_prompt(
    user_text: &str,
    beat: &DirectorBeat,
    scene: &DirectorScene,
    execution: &DirectorExecution,
    previous_speakers: &[Value],
) -> String {
    let assistant = scalar(Some(&beat.assistant_id)).unwrap_or_default();
    let already_spoke = previous_speakers
        .iter()
        .any(|speaker| participant_id(speaker).as_deref() == Some(assistant.as_str()));
    let responsibility = if execution
        .lead_assistant_id
        .as_ref()
        .and_then(|value| scalar(Some(value)))
        .as_deref()
        == Some(assistant.as_str())
    {
        "你是本轮主要负责人。"
    } else {
        "你是本轮协作参与者。"
    };
    let mut sections = vec![
        "你正在参与一个多人智能体会话。前端会单独显示头像和名字；正文直接开始说话，禁止用姓名、角色名或“助手：”报幕。".to_owned(),
        format!("导演场景：domain={}，interactionType={}，{}。", scene.domain, scene.interaction_type, scene.summary),
        format!("当前节拍：{}；回应对象：{}；意图：{}。", beat.speech_act, beat.address_to, beat.intent),
        format!("执行策略：mode={}，observationStrategy={}。{responsibility}", execution.mode, execution.observation_strategy),
        format!("用户最初消息：\n{user_text}"),
        "之前角色的公开回复已经在标准会话历史中；应承接最新内容，不要复述，也不要重复已发生的副作用操作。".to_owned(),
    ];
    if already_spoke {
        sections.push(
            "你本轮已经发言过；这次必须回应伙伴的新内容并推进或收束，不能重新回答用户一遍。"
                .to_owned(),
        );
    }
    if let Some(reply_to) = beat.reply_to_beat {
        sections.push(format!("本次发言承接节拍 {reply_to}。"));
    }
    sections.join("\n\n")
}

fn normalize_plan(raw: RawPlan, participants: &[Value]) -> Option<DirectorPlan> {
    let mut allowed = HashMap::new();
    for participant in participants {
        let id = participant_id(participant)?;
        for identity in [
            Some(id.clone()),
            participant_text(participant, "assistantName"),
            participant_text(participant, "characterName"),
        ]
        .into_iter()
        .flatten()
        {
            allowed.insert(
                identity.to_lowercase(),
                (id.clone(), participant_id_value(participant)?),
            );
        }
    }
    let mut beats = Vec::new();
    let mut appearances: HashMap<String, usize> = HashMap::new();
    for item in raw.beats {
        let Some(key) = scalar(Some(&item.assistant_id)).map(|value| value.to_lowercase()) else {
            continue;
        };
        let Some((id, id_value)) = allowed.get(&key).cloned() else {
            continue;
        };
        if beats.last().is_some_and(|beat: &DirectorBeat| {
            scalar(Some(&beat.assistant_id)).as_deref() == Some(&id)
        }) || appearances.get(&id).copied().unwrap_or_default() >= 2
        {
            continue;
        }
        let speech_act = match item.speech_act.as_str() {
            "respond" | "react" | "support" | "challenge" | "continue" | "close" => item.speech_act,
            _ if beats.is_empty() => "respond".to_owned(),
            _ => "react".to_owned(),
        };
        let previous_id = beats
            .last()
            .and_then(|beat| scalar(Some(&beat.assistant_id)));
        let address_to = if item.address_to == "user" || item.address_to.starts_with("assistant:") {
            item.address_to
        } else if let Some(previous_id) = previous_id {
            format!("assistant:{previous_id}")
        } else {
            "user".to_owned()
        };
        let reply_to_beat = item
            .reply_to_beat
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < beats.len());
        beats.push(DirectorBeat {
            assistant_id: id_value,
            intent: truncate(
                if item.intent.trim().is_empty() {
                    "自然参与当前对话"
                } else {
                    &item.intent
                },
                160,
            ),
            speech_act,
            address_to,
            reply_to_beat,
        });
        *appearances.entry(id).or_default() += 1;
        if beats.len() >= 5 {
            break;
        }
    }
    if beats.is_empty() {
        return None;
    }
    let mut scene = raw.scene.unwrap_or_default();
    if !matches!(
        scene.domain.as_str(),
        "social" | "coding" | "game" | "daily" | "research" | "mixed" | "general"
    ) {
        scene.domain = "general".to_owned();
    }
    if !matches!(
        scene.interaction_type.as_str(),
        "conversation" | "task" | "mixed"
    ) {
        scene.interaction_type = "conversation".to_owned();
    }
    scene.confidence = scene.confidence.clamp(0.0, 1.0);
    scene.summary = truncate(&scene.summary, 120);
    let mut execution = raw.execution.unwrap_or_default();
    if !matches!(
        execution.mode.as_str(),
        "solo" | "lead_support" | "ensemble"
    ) {
        execution.mode = "solo".to_owned();
    }
    let beat_ids = beats
        .iter()
        .filter_map(|beat| scalar(Some(&beat.assistant_id)))
        .collect::<Vec<_>>();
    if execution
        .lead_assistant_id
        .as_ref()
        .and_then(|value| scalar(Some(value)))
        .is_none_or(|id| !beat_ids.contains(&id))
    {
        execution.lead_assistant_id = Some(beats[0].assistant_id.clone());
    }
    if execution
        .tool_owner_assistant_id
        .as_ref()
        .and_then(|value| scalar(Some(value)))
        .is_some_and(|id| !beat_ids.contains(&id))
    {
        execution.tool_owner_assistant_id = None;
    }
    if beat_ids
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1
    {
        execution.mode = "solo".to_owned();
    } else if execution.mode == "solo" {
        execution.mode = "lead_support".to_owned();
    }
    if !matches!(
        execution.observation_strategy.as_str(),
        "none" | "on_demand" | "shared" | "independent"
    ) {
        execution.observation_strategy = "on_demand".to_owned();
    }
    Some(DirectorPlan {
        plan_id: Uuid::now_v7().to_string(),
        beats,
        source: "model".to_owned(),
        diagnostic: None,
        scene,
        execution,
    })
}

fn fallback_plan(user_text: &str, participants: &[Value]) -> DirectorPlan {
    let mentioned = participants.iter().find(|participant| {
        ["assistantName", "characterName"].iter().any(|key| {
            participant_text(participant, key)
                .is_some_and(|name| user_text.to_lowercase().contains(&name.to_lowercase()))
        })
    });
    let participant = mentioned.or_else(|| participants.first());
    let assistant_id = participant
        .and_then(participant_id_value)
        .unwrap_or(Value::Null);
    DirectorPlan {
        plan_id: Uuid::now_v7().to_string(),
        beats: vec![DirectorBeat {
            assistant_id: assistant_id.clone(),
            intent: "直接回应用户".to_owned(),
            speech_act: "respond".to_owned(),
            address_to: "user".to_owned(),
            reply_to_beat: None,
        }],
        source: "fallback".to_owned(),
        diagnostic: None,
        scene: DirectorScene::default(),
        execution: DirectorExecution {
            lead_assistant_id: Some(assistant_id),
            ..DirectorExecution::default()
        },
    }
}

fn fallback_with(mut plan: DirectorPlan, diagnostic: &str) -> DirectorPlan {
    plan.diagnostic = Some(diagnostic.to_owned());
    plan
}

fn parse_raw_plan(text: &str) -> Option<RawPlan> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(&text[start..=end]).ok()
}

pub(crate) fn participant_id(participant: &Value) -> Option<String> {
    scalar(participant.get("assistantId"))
}

pub(crate) fn participant_id_value_for_runtime(value: &Value) -> Option<String> {
    scalar(Some(value))
}

fn participant_id_value(participant: &Value) -> Option<Value> {
    participant
        .get("assistantId")
        .cloned()
        .filter(|value| !value.is_null())
}

fn participant_name(participant: &Value) -> String {
    participant_text(participant, "assistantName")
        .or_else(|| participant_text(participant, "characterName"))
        .unwrap_or_else(|| "未命名助手".to_owned())
}

fn participant_text(participant: &Value, key: &str) -> Option<String> {
    participant
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
}

pub(crate) fn public_participant(participant: &Value, beat_index: usize) -> Value {
    json!({
        "assistantID":participant.get("assistantId"),
        "assistantName":participant.get("assistantName"),
        "characterID":participant.get("characterId"),
        "characterName":participant.get("characterName"),
        "signature":participant.get("signature"),
        "avatarUrl":participant.get("avatarUrl"),
        "standingImageUrl":participant.get("standingImageUrl"),
        "ttsConfigID":participant.get("ttsConfigId"),
        "sttConfigID":participant.get("sttConfigId"),
        "position":participant.get("position"),
        "turnIndex":beat_index,
        "beatIndex":beat_index,
    })
}

fn scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participants() -> Vec<Value> {
        vec![
            json!({"assistantId":1,"assistantName":"甲","characterId":11}),
            json!({"assistantId":2,"assistantName":"乙","characterId":22}),
        ]
    }

    #[test]
    fn normalization_rejects_unknown_consecutive_and_excessive_beats() {
        let raw: RawPlan = serde_json::from_value(json!({
            "scene":{"domain":"invalid","interactionType":"invalid","confidence":2,"summary":"讨论"},
            "execution":{"mode":"solo","leadAssistantId":99,"observationStrategy":"invalid"},
            "beats":[
                {"assistantId":1,"intent":"先回答"},
                {"assistantId":1,"intent":"重复"},
                {"assistantId":99,"intent":"未知"},
                {"assistantId":2,"intent":"补充","addressTo":"bad"},
                {"assistantId":1,"intent":"收束"},
                {"assistantId":2,"intent":"超额"}
            ]
        }))
        .expect("raw");
        let plan = normalize_plan(raw, &participants()).expect("plan");
        assert_eq!(plan.beats.len(), 4);
        assert_eq!(plan.beats[1].address_to, "assistant:1");
        assert_eq!(plan.scene.domain, "general");
        assert_eq!(plan.execution.mode, "lead_support");
        assert_eq!(plan.execution.lead_assistant_id, Some(json!(1)));
    }

    #[test]
    fn fallback_prefers_mentioned_participant() {
        let plan = fallback_plan("请乙回答", &participants());
        assert_eq!(plan.beats[0].assistant_id, json!(2));
    }

    #[test]
    fn public_participant_does_not_copy_profile_or_credentials() {
        let value = public_participant(
            &json!({"assistantId":1,"assistantName":"甲","profile":{"api_key":"secret"}}),
            0,
        );
        assert!(!value.to_string().contains("secret"));
        assert!(value.get("profile").is_none());
    }
}
