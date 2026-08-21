use chrono::{DateTime, Duration, Utc};
use mon_agent_domain::{QuestionRequestId, TurnId};
use mon_agent_store::{
    JobRecord, MemoInput, MemoryRecord, SelfAwakeDiaryRecord, SelfAwakeRunRecord, Store, StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) const SCHEMA_VERSION: &str = "self-awake.v1";
const DEFAULT_NEXT_WAKE_MINUTES: i64 = 720;
const MAX_HISTORY_ITEMS: usize = 20;
const MAX_HISTORY_CHARS: usize = 12_000;

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
    memories: &[MemoryRecord],
    diaries: &[SelfAwakeDiaryRecord],
    session_environment: &Value,
) -> SelfAwakeRequest {
    let time = mon_agent_environment::current_time_context(session_environment);
    let author = participants.first().cloned().unwrap_or_else(|| json!({}));
    let trigger = bounded_value(
        job.payload.get("trigger").cloned().unwrap_or_else(|| {
            json!({
                "type":"scheduled",
                "reason":job.payload.get("prompt").and_then(Value::as_str).unwrap_or("periodic observation"),
            })
        }),
        12_000,
    );
    let history = bounded_history(job.payload.get("conversationHistory"));
    let calendar = job
        .payload
        .get("calendar")
        .filter(|value| !value.is_null() && !value.as_array().is_some_and(Vec::is_empty))
        .cloned()
        .or_else(|| {
            mon_agent_environment::calendar_context(&json!({}), session_environment)
                .ok()
                .map(|(_, calendar)| calendar)
        })
        .unwrap_or_else(|| json!({}));
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
            "location":session_environment.get("location").cloned().unwrap_or_else(||json!({})),
            "calendar":calendar,
        }),
        memories: memories
            .iter()
            .take(8)
            .map(|memory| json!({"kind":memory.kind,"content":truncate(&memory.content, 1000)}))
            .collect(),
        recent_diaries: diaries
            .iter()
            .take(5)
            .map(|diary| {
                json!({
                    "title":diary.title,
                    "content":truncate(&diary.content, 1500),
                    "mood":diary.mood,
                    "created_at":diary.created_at,
                })
            })
            .collect(),
        conversation_history: history,
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
    let request_json = serde_json::to_string_pretty(request).unwrap_or_else(|_| "{}".to_owned());
    format!(
        "You are executing a private background Self-Awake state-machine step. Analyze the bounded context below. Do not chat, use markdown, or call external-contact tools. Return exactly one JSON object matching the contract.\n\n\
Allowed action values: observe_only, write_diary, remind_user, create_task, ask_user, run_safe_check, sync_context.\n\
Required fields: mood, current_desire, observations (2-5 short facts), should_interrupt_user, action, action_payload, next_wake, diary.\n\
next_wake must contain after_minutes (1..10080) and reason. diary is null unless a durable diary is worthwhile.\n\
Only interrupt for information that is timely, actionable, and valuable. A memo_due trigger must interrupt and preserve its exact title/details in action_payload. Never send more than one notification; the host performs delivery.\n\
For remind_user or ask_user, action_payload must contain title and message. For create_task, include title, content, due_at when known.\n\
If uncertain, choose observe_only and schedule a conservative next wake.\n\nREQUEST:\n{request_json}"
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
        "create_task" | "remind_user" => {
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
            store
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
                    json!({"runId":run.id,"status":"ok","scope":"local_runtime"}),
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
    if !memo_due && !matches!(decision.action.as_str(), "remind_user" | "ask_user") {
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
        .unwrap_or("MonAgent 提醒");
    let message = source
        .get("details")
        .or_else(|| source.get("message"))
        .or_else(|| source.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("有一项需要你留意的事项。");
    Some(json!({
        "title":truncate(title, 240),
        "message":truncate(message, 4_000),
        "channel":"auto",
        "reason":if memo_due { "memo_due" } else { "value_based_interrupt" },
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
        "observe_only",
        "write_diary",
        "remind_user",
        "create_task",
        "ask_user",
        "run_safe_check",
        "sync_context",
    ];
    if !ACTIONS.contains(&decision.action.as_str()) {
        decision.action = "observe_only".to_owned();
        decision.should_interrupt_user = false;
        decision.action_payload = json!({});
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
        decision.action_payload = json!({
            "title":trigger.get("title").cloned().unwrap_or_else(|| json!("到期提醒")),
            "message":trigger.get("details").or_else(|| trigger.get("content")).cloned().unwrap_or_else(|| json!("一项备忘录已经到期。")),
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
        action: "observe_only".to_owned(),
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

fn bounded_history(value: Option<&Value>) -> Vec<Value> {
    let mut remaining = MAX_HISTORY_CHARS;
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .take(MAX_HISTORY_ITEMS)
        .filter_map(|entry| {
            if remaining == 0 {
                return None;
            }
            let role = entry
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let content = entry
                .get("content")
                .or_else(|| entry.get("text"))
                .and_then(Value::as_str)?;
            let content = truncate(content, remaining.min(2_000));
            remaining = remaining.saturating_sub(content.chars().count());
            Some(json!({"role":role,"content":content}))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn bounded_value(value: Value, max_chars: usize) -> Value {
    let encoded = serde_json::to_string(&value).unwrap_or_default();
    if encoded.chars().count() <= max_chars {
        value
    } else {
        json!({
            "type":value.get("type").and_then(Value::as_str).unwrap_or("event"),
            "eventId":value.get("eventId").cloned().unwrap_or(Value::Null),
            "eventType":value.get("eventType").cloned().unwrap_or(Value::Null),
            "truncated":true,
            "summary":truncate(&encoded, max_chars),
        })
    }
}

fn trigger_type(trigger: &Value) -> &str {
    trigger
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("scheduled")
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .to_owned()
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
    fn request_uses_session_environment_and_current_local_calendar() {
        let job = JobRecord {
            id: Uuid::now_v7(),
            kind: "self_awake".to_owned(),
            session_id: Some(mon_agent_domain::SessionId::new()),
            due_at: 0,
            payload: json!({}),
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
        assert_eq!(value["environment"]["location"]["city"], "上海");
        assert_eq!(
            value["environment"]["calendar"]["source"],
            "local_calendar_rules"
        );
    }

    #[test]
    fn request_preserves_the_durable_schedule_reason() {
        let job = JobRecord {
            id: Uuid::now_v7(),
            kind: "self_awake".to_owned(),
            session_id: Some(mon_agent_domain::SessionId::new()),
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
    fn invalid_output_falls_back_safely() {
        let decision = parse_decision("not json", &json!({"type":"scheduled"}));
        assert_eq!(decision.action, "observe_only");
        assert!(!decision.should_interrupt_user);
        assert_eq!(decision.next_wake.after_minutes, 720);
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
