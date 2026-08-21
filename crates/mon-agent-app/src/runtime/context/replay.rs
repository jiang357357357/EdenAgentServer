use super::super::message::message_content_text;
use mon_agent_core::{AgentContext, Message, build_session_context, sanitize_model_history};
use mon_agent_store::EventRecord;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(in crate::runtime) fn director_conversation_context(
    events: &[EventRecord],
    max_chars: usize,
) -> String {
    let mut lines = events
        .iter()
        .rev()
        .filter(|event| event.event_type == "agent.message_end")
        .filter_map(|event| event.payload.get("message"))
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str)?;
            let text = message_content_text(message);
            (!text.trim().is_empty()).then(|| format!("{role}: {text}"))
        })
        .take(20)
        .collect::<Vec<_>>();
    lines.reverse();
    lines
        .join("\n")
        .chars()
        .rev()
        .take(max_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

pub(in crate::runtime) fn latest_prompt_cache_states(
    events: &[EventRecord],
) -> HashMap<String, Value> {
    let mut states = HashMap::new();
    for event in events {
        if event.event_type != "context.cache_state" {
            continue;
        }
        let Some(assistant_id) = event.payload.get("assistantId").and_then(Value::as_str) else {
            continue;
        };
        if let Some(cache) = event.payload.get("cache") {
            states.insert(assistant_id.to_owned(), cache.clone());
        }
    }
    states
}

pub(in crate::runtime) fn latest_skill_snapshots(
    events: &[EventRecord],
) -> HashMap<String, String> {
    let mut snapshots = HashMap::new();
    for event in events {
        if event.event_type != "context.skill_snapshot" {
            continue;
        }
        let Some(assistant_id) = event.payload.get("assistantId").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = event.payload.get("content").and_then(Value::as_str) else {
            continue;
        };
        let content = content
            .split_once('>')
            .and_then(|(_, value)| {
                value
                    .rsplit_once("</active_skill_snapshot>")
                    .map(|(body, _)| body)
            })
            .unwrap_or(content)
            .trim();
        snapshots.insert(assistant_id.to_owned(), content.to_owned());
    }
    snapshots
}

pub(in crate::runtime) fn prompt_section<'a>(prompt: &'a str, marker: &str) -> &'a str {
    let Some(start) = prompt.find(marker) else {
        return "";
    };
    let body = &prompt[start..];
    let end = body
        .char_indices()
        .skip(marker.chars().count())
        .find_map(|(index, _)| body[index..].starts_with("\n# ").then_some(index))
        .unwrap_or(body.len());
    &body[..end]
}

pub(in crate::runtime) fn skill_prompt_section(prompt: &str) -> &str {
    let Some(start) = prompt.find("Available skills:") else {
        return "";
    };
    let body = &prompt[start..];
    let end = body
        .find("\nUse load_skill")
        .map_or(body.len(), |index| index + "\nUse load_skill".len());
    &body[..end]
}

pub(in crate::runtime) fn conversation_entries(events: &[EventRecord]) -> Vec<Value> {
    let completed_turns = events
        .iter()
        .filter(|event| event.event_type == "turn.completed")
        .filter_map(|event| event.turn_id)
        .collect::<HashSet<_>>();
    events
        .iter()
        .filter_map(|event| {
            if event.event_type == "context.compacted" {
                let mut value = event.payload.clone();
                value["type"] = json!("compaction");
                value["id"] = json!(event.id.to_string());
                return Some(value);
            }
            if event.event_type == "context.skill_snapshot" {
                return Some(json!({
                    "type":"custom_message",
                    "id":event.id.to_string(),
                    "customType":"skillSnapshot",
                    "content":event.payload.get("content"),
                    "display":false,
                    "details":{
                        "snapshotID":event.payload.get("snapshotID"),
                        "assistantId":event.payload.get("assistantId"),
                    },
                    "timestamp":event.created_at,
                }));
            }
            if event.event_type == "context.subagent_notification" {
                return Some(json!({
                    "type":"custom_message",
                    "id":event.id.to_string(),
                    "customType":"subagentNotification",
                    "content":event.payload.get("content"),
                    "display":false,
                    "details":event.payload.get("details"),
                    "timestamp":event.created_at,
                }));
            }
            if event.event_type != "agent.message_end"
                || !event
                    .turn_id
                    .is_some_and(|turn| completed_turns.contains(&turn))
            {
                return None;
            }
            if event
                .payload
                .get("message")
                .and_then(|message| message.get("transient"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                return None;
            }
            Some(json!({
                "type":"message",
                "id":event.id.to_string(),
                "message":event.payload.get("message")?,
            }))
        })
        .collect()
}

pub(in crate::runtime) fn rebuild_context(
    events: &[EventRecord],
    system_prompt: &str,
) -> AgentContext {
    let entries = conversation_entries(events);
    let messages =
        serde_json::from_value::<Vec<Message>>(build_session_context(&entries)["messages"].clone())
            .unwrap_or_default();
    let messages = sanitize_model_history(&messages);
    AgentContext {
        system_prompt: system_prompt.to_owned(),
        messages,
        metadata: json!({}),
    }
}
