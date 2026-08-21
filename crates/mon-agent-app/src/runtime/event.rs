use mon_agent_core::{AgentEvent, Message};
use mon_agent_store::{InputRecord, Store, StoreError};
use serde_json::{Value, json};

pub(super) fn annotate_agent_event(
    event: AgentEvent,
    speaker: &Value,
    orchestration: &Value,
) -> AgentEvent {
    match event {
        AgentEvent::MessageStart { mut message } => {
            annotate_message(&mut message, speaker, orchestration);
            AgentEvent::MessageStart { message }
        }
        AgentEvent::MessageUpdate {
            mut message,
            delta,
            assistant_message_event,
        } => {
            annotate_assistant(&mut message, speaker, orchestration);
            AgentEvent::MessageUpdate {
                message,
                delta,
                assistant_message_event,
            }
        }
        AgentEvent::StreamReset {
            mut message,
            reason,
        } => {
            annotate_assistant(&mut message, speaker, orchestration);
            AgentEvent::StreamReset { message, reason }
        }
        AgentEvent::MessageEnd { mut message } => {
            annotate_message(&mut message, speaker, orchestration);
            AgentEvent::MessageEnd { message }
        }
        AgentEvent::TurnEnd {
            turn,
            mut message,
            tool_results,
        } => {
            annotate_assistant(&mut message, speaker, orchestration);
            AgentEvent::TurnEnd {
                turn,
                message,
                tool_results,
            }
        }
        event => event,
    }
}

fn annotate_message(message: &mut Message, speaker: &Value, orchestration: &Value) {
    if let Message::Assistant(message) = message {
        annotate_assistant(message, speaker, orchestration);
    }
}

fn annotate_assistant(
    message: &mut mon_agent_core::AssistantMessage,
    speaker: &Value,
    orchestration: &Value,
) {
    message.extra.insert("speaker".to_owned(), speaker.clone());
    message
        .extra
        .insert("orchestration".to_owned(), orchestration.clone());
}

pub(super) async fn persist_agent_event(
    store: &Store,
    input: &InputRecord,
    event: AgentEvent,
    active_message_id: &mut Option<uuid::Uuid>,
) -> Result<(), StoreError> {
    let mut payload = serde_json::to_value(event).map_err(StoreError::from)?;
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let tracks_stable_message = payload
        .get("message")
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        != Some("toolResult");
    if tracks_stable_message
        && matches!(kind.as_str(), "message_update" | "message_end")
        && let (Some(message_id), Some(object)) = (*active_message_id, payload.as_object_mut())
    {
        object.insert("messageId".to_owned(), json!(message_id));
    }
    let record = store
        .append_event(
            input.session_id,
            Some(input.turn_id),
            format!("agent.{kind}"),
            payload,
        )
        .await?;
    if tracks_stable_message && kind == "message_start" && active_message_id.is_none() {
        *active_message_id = Some(record.id);
    } else if tracks_stable_message && kind == "message_end" {
        *active_message_id = None;
    }
    Ok(())
}
