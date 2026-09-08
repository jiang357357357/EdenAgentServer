use chrono::{DateTime, Duration, Utc};
use eden_agent_domain::{QuestionRequestId, TurnId};
use eden_agent_store::{
    JobRecord, MemoInput, MemoryRecord, SelfAwakeDiaryRecord, SelfAwakeRunRecord, Store, StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) const SCHEMA_VERSION: &str = "self-awake.v1";
const DEFAULT_NEXT_WAKE_MINUTES: i64 = 720;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct SelfAwakeRequest {
    schema_version: &'static str,
    job_id: String,
    event_id: String,
    idempotency_key: String,
    trigger: Value,
    author: Value,
    environment: Value,
    memories: Vec<Value>,
    recent_diaries: Vec<Value>,
    conversation_history: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct SelfAwakeDecision {
    #[serde(default)]
    pub mood: String,
    #[serde(default)]
    pub current_desire: String,
    #[serde(default)]
    pub observations: Vec<String>,
    #[serde(default)]
    pub should_interrupt_user: bool,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub action_payload: Value,
    #[serde(default)]
    pub next_wake: NextWake,
    #[serde(default)]
    pub diary: Option<DiaryDecision>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct NextWake {
    #[serde(default = "default_next_wake_minutes")]
    pub after_minutes: i64,
    #[serde(default)]
    pub reason: String,
}

impl Default for NextWake {
    fn default() -> Self {
        Self {
            after_minutes: DEFAULT_NEXT_WAKE_MINUTES,
            reason: "periodic observation".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct DiaryDecision {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
}

pub(crate) fn build_request(
    job: &JobRecord,
    participants: &[Value],
    _memories: &[MemoryRecord],
    _diaries: &[SelfAwakeDiaryRecord],
    session_environment: &Value,
) -> SelfAwakeRequest {
    let time = eden_agent_environment::current_time_context(session_environment);
    let author = participants.first().cloned().unwrap_or_else(|| json!({}));
    // Allowlist even for old queued jobs carrying full desktop snapshots.
    let raw_trigger = job.payload.get("trigger").cloned().unwrap_or_else(|| json!({
        "type":"scheduled", "reason":job.payload.get("prompt").and_then(Value::as_str).unwrap_or("periodic observation")
    }));
    let mut trigger = json!({});
    for key in ["type", "source", "reason", "wake_reason", "occurred_at", "current_time", "title", "details"] {
        if let Some(value) = raw_trigger.get(key).and_then(Value::as_str) {
            trigger[key] = json!(truncate(value, 4000));
        }
    }
    SelfAwakeRequest {
        schema_version: SCHEMA_VERSION,
        job_id: job.id.to_string(),
        event_id: job
            .payload
            .get("eventId")
            .and_then(Value::as_str)
            .unwrap_or(job.idempotency_key.as_str())
            .to_owned(),
        idempotency_key: job.idempotency_key.clone(),
        trigger,
        author,
        environment: json!({
            "utc_time":time.get("utcTime"),
            "local_time":time.get("localTime"),
            "utc_offset":time.get("utcOffset"),
            "timezone":session_environment.get("timezone"),
            "locale":session_environment.get("locale").cloned().unwrap_or_else(||json!(std::env::var("LANG").unwrap_or_else(|_| "zh-CN".to_owned()))),
        }),
        memories: Vec::new(),
        recent_diaries: Vec::new(),
        conversation_history: Vec::new(),
    }
}

pub(crate) fn author_snapshot(request: &SelfAwakeRequest) -> Value {
    let author = &request.author;
    json!({
        "assistantId": string_field(author, &["assistantId", "assistant_id", "id"]),
        "assistantName": string_field(author, &["assistantName", "assistant_name", "name"]),
        "characterId": string_field(author, &["characterId", "character_id"]),
        "characterName": string_field(author, &["characterName", "character_name"]),
        "capturedAt": Utc::now().to_rfc3339(),
    })
}

pub(crate) fn event_id(request: &SelfAwakeRequest) -> &str {
    &request.event_id
}

pub(crate) fn to_value(request: &SelfAwakeRequest) -> Value {
    serde_json::to_value(request).unwrap_or_else(|_| json!({"schema_version":SCHEMA_VERSION}))
}

pub(crate) fn task_prompt(request: &SelfAwakeRequest) -> String {
    // The full profile stays in the durable run for retry identity. Its role
    // instructions are already compiled into the system prompt; visual catalogs
    // and duplicated profile data do not belong in the per-wake model request.
    let mut model_request = to_value(request);
    if let Some(author) = model_request["author"].as_object_mut() { author.remove("profile"); }
    let request_json = serde_json::to_string_pretty(&model_request).unwrap_or_else(|_| "{}".to_owned());
    format!(
        r#"这是当前角色的一次后台自醒。先决定自己此刻想做什么，再按需获取信息、采取行动，最后记录本轮经历。

【判断与行动】
从自己的性格、关系和真实牵挂出发，选择聊天、分享、提醒、推进一件事或等待。有具体想说的话就落实为联系，不要只在日记里反复计划。忙碌不等于拒绝简短异步消息；明确的安静要求、睡眠和近期未回复的联系应被尊重。不要求每轮联系，也不以等待为默认答案。
初始只提供身份、时间和醒来原因。所需信息自己用工具获取，不必遍历所有类别。未经查询只能说未知，不能断言没有消息、待办或异常；历史日记不能证明当前情况，也不能当作本轮经历。
联系前用 get_self_awake_context 的 recent_contacts 检查近期联系，需要时查询回复及 qq_bot_targets / external_email_status。自主选择 qq（已配置的用户私聊）、email 或 desktop，可指定有序 fallbackChannels；无固定优先级。桌面窗口直接调用 show_desktop_reminder(title, message)，返回 ID 后可用 get_desktop_reminder 查询关闭状态。成功调用后不要再请求其他通知。QQ、邮件或备用渠道投递仍用 chat_user、remind_user 或 ask_user 并提供实际消息；不要用终端重复发送，不选择群或其他收件人。

【输出协议】
工具使用结束后只返回一个 JSON 对象，不加 Markdown。必需字段：mood、current_desire、observations（0—5 条有依据的事实）、should_interrupt_user、action、action_payload、next_wake、diary。
action：chat_user、remind_user、create_task、ask_user、run_safe_check、sync_context、write_diary。write_diary 表示本轮没有其他最终动作，不是自醒目标；其他动作同样记录日记。联系动作的 action_payload 包含 title、message、channel，可选 fallbackChannels，并设置 should_interrupt_user=true（表示请求发送，不要求用户立即回复）。create_task 包含 title、content，可选 due_at。memo_due 必须提醒并保留原始标题和详情。
next_wake 包含 after_minutes（1—10080）及具体 reason，按实际后续需要安排。
最后写 diary：非空 title、content，用角色第一人称和用户语言记录本轮做了什么、感受和后续意图，允许一两句。不要重写旧日记、套用他人经历、虚构检查或把联系请求写成已送达；实际工具及投递结果由执行记录保存。

REQUEST:
{request_json}"#
    )
}

pub(crate) fn parse_decision(text: &str, trigger: &Value) -> SelfAwakeDecision {
    let parsed = json_object(text)
        .and_then(|value| serde_json::from_value::<SelfAwakeDecision>(value).ok())
        .unwrap_or_else(fallback_decision);
    sanitize_decision(parsed, trigger)
}

pub(crate) async fn apply_decision(
    store: &Store,
    run: &SelfAwakeRunRecord,
    turn_id: TurnId,
    trigger: &Value,
    decision: &SelfAwakeDecision,
) -> Result<(), StoreError> {
    let action_payload = &decision.action_payload;
    match decision.action.as_str() {
        "create_task" => {
            let title = action_payload
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(if decision.action == "create_task" {
                    "自醒任务"
                } else {
                    "自醒提醒"
                });
            let content = action_payload
                .get("content")
                .or_else(|| action_payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let due_at = parse_due_at(action_payload.get("due_at"));
            let remind_at =
                (decision.action == "remind_user").then_some(Utc::now().timestamp_millis());
            let memo = store
                .create_memo_idempotent(
                    MemoInput {
                        title: truncate(title, 240),
                        content: truncate(content, 4_000),
                        kind: if decision.action == "create_task" {
                            "todo"
                        } else {
                            "reminder"
                        }
                        .to_owned(),
                        remind_at,
                        due_at,
                        source: "self_awake".to_owned(),
                        related_session_id: run.session_id.to_string(),
                        metadata: json!({"runId":run.id,"trigger":trigger}),
                        ..Default::default()
                    },
                    &format!("self-awake:{}:{}", run.id, decision.action),
                )
                .await?;
            store.append_event(run.session_id, Some(turn_id), "self_awake.action_applied",
                json!({"runId":run.id,"action":decision.action,"memoId":memo.id,"status":"persisted"})).await?;
        }
        "ask_user" => {
            let message = action_payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("我需要向你确认一件事。");
            let question_id = run
                .id
                .to_string()
                .parse::<QuestionRequestId>()
                .unwrap_or_else(|_| QuestionRequestId::new());
            store
                .create_question_idempotent(
                    question_id,
                    run.session_id,
                    turn_id,
                    json!([{"id":"self_awake_question","header":"自醒确认","question":truncate(message, 1000)}]),
                )
                .await?;
        }
        "run_safe_check" => {
            store
                .append_event(
                    run.session_id,
                    Some(turn_id),
                    "self_awake.safe_check",
                    json!({"runId":run.id,"status":"requested","scope":"local_runtime","note":"Decision marker only; actual checks are recorded as tool executions."}),
                )
                .await?;
        }
        "sync_context" => {
            store
                .append_event(
                    run.session_id,
                    Some(turn_id),
                    "self_awake.sync_context",
                    json!({"runId":run.id}),
                )
                .await?;
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn diary_value(decision: &SelfAwakeDecision) -> Option<Value> {
    let diary = decision.diary.as_ref()?;
    if diary.content.trim().is_empty() {
        return None;
    }
    Some(json!({
        "title":if diary.title.trim().is_empty() { "自醒日记" } else { diary.title.trim() },
        "content":truncate(&diary.content, 8_000),
        "mood":truncate(&decision.mood, 120),
        "currentDesire":truncate(&decision.current_desire, 500),
    }))
}

pub(crate) fn notification_value(decision: &SelfAwakeDecision, trigger: &Value) -> Option<Value> {
    let memo_due = trigger_type(trigger) == "memo_due";
    if !decision.should_interrupt_user && !memo_due {
        return None;
    }
    if !memo_due && !matches!(decision.action.as_str(), "chat_user" | "remind_user" | "ask_user") {
        return None;
    }
    let source = if memo_due {
        trigger
    } else {
        &decision.action_payload
    };
    let title = source
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Eden Agent 提醒");
    let message = source
        .get("details")
        .or_else(|| source.get("message"))
        .or_else(|| source.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("有一项需要你留意的事项。");
    Some(json!({
        "title":truncate(title, 240),
        "message":truncate(message, 4_000),
        "channel":decision.action_payload.get("channel").and_then(Value::as_str).unwrap_or("qq"),
        "fallbackChannels":decision.action_payload.get("fallbackChannels").cloned().unwrap_or_else(||json!([])),
        "expiresAt":if decision.action == "chat_user" { Some((Utc::now()+Duration::hours(2)).timestamp_millis()) } else { None },
        "reason":if memo_due { "memo_due" } else if decision.action == "chat_user" { "character_initiative" } else { "value_based_interrupt" },
    }))
}

pub(crate) fn next_wake(
    run: &SelfAwakeRunRecord,
    decision: &SelfAwakeDecision,
) -> (i64, Value, String) {
    let due = Utc::now()
        .checked_add_signed(Duration::minutes(decision.next_wake.after_minutes))
        .unwrap_or_else(|| Utc::now() + Duration::minutes(DEFAULT_NEXT_WAKE_MINUTES));
    let key = format!("self-awake:{}:{}", run.session_id, due.timestamp_millis());
    (
        due.timestamp_millis(),
        json!({
            "schemaVersion":SCHEMA_VERSION,
            "eventId":Uuid::now_v7(),
            "trigger":{"type":"scheduled","previousRunId":run.id,"reason":decision.next_wake.reason},
        }),
        key,
    )
}

fn sanitize_decision(mut decision: SelfAwakeDecision, trigger: &Value) -> SelfAwakeDecision {
    const ACTIONS: [&str; 7] = [
        "write_diary",
        "chat_user",
        "remind_user",
        "create_task",
        "ask_user",
        "run_safe_check",
        "sync_context",
    ];
    if !ACTIONS.contains(&decision.action.as_str()) {
        decision.action = "write_diary".to_owned();
        decision.should_interrupt_user = false;
        decision.action_payload = json!({});
    }
    if decision.action == "chat_user" {
        if decision.action_payload.get("message").and_then(Value::as_str).is_some_and(|text|!text.trim().is_empty()) {
            decision.should_interrupt_user=true;
        } else {
            decision.action="write_diary".into();decision.should_interrupt_user=false;
        }
    }
    decision.mood = truncate(&decision.mood, 120);
    decision.current_desire = truncate(&decision.current_desire, 500);
    decision.observations = decision
        .observations
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .take(5)
        .map(|value| truncate(&value, 500))
        .collect();
    decision.next_wake.after_minutes = decision.next_wake.after_minutes.clamp(1, 10_080);
    decision.next_wake.reason = truncate(&decision.next_wake.reason, 500);
    if trigger_type(trigger) == "memo_due" {
        decision.should_interrupt_user = true;
        decision.action = "remind_user".to_owned();
        let channel=decision.action_payload.get("channel").cloned().unwrap_or_else(||json!("qq"));
        let fallback=decision.action_payload.get("fallbackChannels").cloned().unwrap_or_else(||json!([]));
        decision.action_payload = json!({
            "channel":channel,"fallbackChannels":fallback,
            "title":trigger.get("title").cloned().unwrap_or_else(|| json!("到期提醒")),
            "message":trigger.get("details").or_else(|| trigger.get("content")).cloned().unwrap_or_else(|| json!("一项备忘录已经到期。")),
        });
    }
    if decision.diary.as_ref().is_none_or(|diary| diary.content.trim().is_empty()) {
        decision.diary = Some(DiaryDecision {
            title: "自醒记录".to_owned(),
            content: format!(
                "【自动整理】模型未提供有效日记，以下保存本轮返回的摘要，不代表独立核实或执行了工具。\n触发原因：{}\n本轮观察：\n{}\n当前想法：{}\n行动决策：{}\n下次醒来：{} 分钟后；{}",
                trigger.get("reason").and_then(Value::as_str).unwrap_or("未记录"),
                decision.observations.join("\n"), decision.current_desire, decision.action,
                decision.next_wake.after_minutes, decision.next_wake.reason,
            ),
        });
    }
    decision
}

fn fallback_decision() -> SelfAwakeDecision {
    SelfAwakeDecision {
        mood: "calm".to_owned(),
        current_desire: "continue observing without interruption".to_owned(),
        observations: vec!["The model decision was unavailable or invalid.".to_owned()],
        should_interrupt_user: false,
        action: "write_diary".to_owned(),
        action_payload: json!({}),
        next_wake: NextWake::default(),
        diary: None,
    }
}

fn json_object(text: &str) -> Option<Value> {
    let trimmed = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(trimmed).ok().or_else(|| {
        let start = trimmed.find('{')?;
        let end = trimmed.rfind('}')?;
        serde_json::from_str(&trimmed[start..=end]).ok()
    })
}


fn trigger_type(trigger: &Value) -> &str {
    trigger
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("scheduled")
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| match value.get(*key) {
            Some(Value::String(value)) => Some(value.clone()),
            Some(Value::Number(value)) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn parse_due_at(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(value)) => value.as_i64(),
        Some(Value::String(value)) => DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|value| value.timestamp_millis()),
        _ => None,
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn default_next_wake_minutes() -> i64 {
    DEFAULT_NEXT_WAKE_MINUTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_only_supplies_basic_environment() {
        let job = JobRecord {
            id: Uuid::now_v7(),
            kind: "self_awake".to_owned(),
            session_id: Some(eden_agent_domain::SessionId::new()),
            due_at: 0,
            payload: json!({"trigger":{"type":"startup","reason":"重启检查","user_activity":{"window_title":"PRIVATE_WINDOW"},"last_diary":"PRIVATE_DIARY","module_status":{"core":true}},"conversationHistory":[{"role":"user","content":"PRIVATE_CHAT"}],"calendar":{"private":"PRIVATE_CALENDAR"}}),
            state: "claimed".to_owned(),
            attempts: 1,
            lease_until: None,
            idempotency_key: "self-awake:test".to_owned(),
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        let request = build_request(
            &job,
            &[],
            &[],
            &[],
            &json!({
                "timezone":"Asia/Shanghai",
                "locale":"zh-CN",
                "location":{"city":"上海"}
            }),
        );
        let value = serde_json::to_value(request).expect("request");
        assert_eq!(value["environment"]["timezone"], "Asia/Shanghai");
        assert!(value["environment"].get("location").is_none());
        assert!(value["environment"].get("calendar").is_none());
        assert!(!value.to_string().contains("PRIVATE_"));
        assert_eq!(value["trigger"]["reason"], "重启检查");
        assert_eq!(value["recent_diaries"], json!([]));
        assert_eq!(value["memories"], json!([]));
    }

    #[test]
    fn request_preserves_the_durable_schedule_reason() {
        let job = JobRecord {
            id: Uuid::now_v7(),
            kind: "self_awake".to_owned(),
            session_id: Some(eden_agent_domain::SessionId::new()),
            due_at: 0,
            payload: json!({"prompt":"检查游戏观察状态"}),
            state: "claimed".to_owned(),
            attempts: 1,
            lease_until: None,
            idempotency_key: "self-awake:reason".to_owned(),
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        let value =
            serde_json::to_value(build_request(&job, &[], &[], &[], &json!({}))).expect("request");
        assert_eq!(value["trigger"]["type"], "scheduled");
        assert_eq!(value["trigger"]["reason"], "检查游戏观察状态");
    }

    #[test]
    fn author_identifiers_accept_core_numbers_and_rpc_strings() {
        for value in [json!({"assistantId":18,"characterId":18}), json!({"assistantId":"18","characterId":"18"})] {
            assert_eq!(string_field(&value, &["assistantId"]), "18");
            assert_eq!(string_field(&value, &["characterId"]), "18");
        }
        assert_eq!(string_field(&json!({"id":null}), &["id"]), "");
    }

    #[test]
    fn proactive_chat_keeps_character_message_and_selected_channels() {
        let decision=parse_decision(r#"{"action":"chat_user","action_payload":{"title":"想和你聊聊","message":"老师，我刚想到一件事。","channel":"desktop","fallbackChannels":["qq","email"]},"diary":{"title":"想聊聊","content":"准备联系老师。"}}"#,&json!({"type":"scheduled"}));
        let notification=notification_value(&decision,&json!({"type":"scheduled"})).unwrap();
        assert_eq!(notification["channel"],"desktop");
        assert_eq!(notification["fallbackChannels"],json!(["qq","email"]));
        assert_eq!(notification["message"],"老师，我刚想到一件事。");
        assert_eq!(notification["reason"],"character_initiative");
        let empty=parse_decision(r#"{"action":"chat_user","action_payload":{}}"#,&json!({}));
        assert!(notification_value(&empty,&json!({})).is_none());
    }

    #[test]
    fn invalid_output_falls_back_safely() {
        let decision = parse_decision("not json", &json!({"type":"scheduled"}));
        assert_eq!(decision.action, "write_diary");
        assert!(!decision.should_interrupt_user);
        assert_eq!(decision.next_wake.after_minutes, 720);
        assert!(diary_value(&decision).unwrap()["content"].as_str().unwrap().contains("自动整理"));
    }

    #[test]
    fn every_decision_keeps_or_creates_a_diary() {
        for text in [r#"{"action":"observe_only","diary":null}"#, r#"{"action":"write_diary","diary":{"title":"","content":" "}}"#, r#"{"action":"unknown"}"#] {
            let decision = parse_decision(text, &json!({"reason":"重启检查"}));
            assert_eq!(decision.action, "write_diary");
            assert!(diary_value(&decision).unwrap()["content"].as_str().unwrap().contains("重启检查"));
        }
        let decision = parse_decision(r#"{"action":"write_diary","diary":{"title":"检查","content":"实际日记内容"}}"#, &json!({}));
        assert_eq!(diary_value(&decision).unwrap()["content"], "实际日记内容");
    }

    #[test]
    fn memo_due_forces_exact_single_notification() {
        let trigger = json!({"type":"memo_due","title":"缴费","details":"今天 18:00 前缴费"});
        let decision = parse_decision(
            r#"{"action":"observe_only","next_wake":{"after_minutes":99999}}"#,
            &trigger,
        );
        assert_eq!(decision.action, "remind_user");
        assert!(decision.should_interrupt_user);
        assert_eq!(decision.next_wake.after_minutes, 10_080);
        let notification = notification_value(&decision, &trigger).expect("notification");
        assert_eq!(notification["title"], "缴费");
        assert_eq!(notification["message"], "今天 18:00 前缴费");
    }
}
