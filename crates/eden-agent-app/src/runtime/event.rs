use eden_agent_core::{AgentEvent, Message};
use eden_agent_store::{InputRecord, Store, StoreError};
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct EventPersistenceState {
    active_message_id: Option<uuid::Uuid>,
    stream: eden_agent_store::StreamEventWriter,
}

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
    message: &mut eden_agent_core::AssistantMessage,
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
    state: &mut EventPersistenceState,
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
        && let (Some(message_id), Some(object)) = (state.active_message_id, payload.as_object_mut())
    {
        object.insert("messageId".to_owned(), json!(message_id));
    }
    let record = if kind == "message_update" {
        state
            .stream
            .append(store, input.session_id, Some(input.turn_id), payload)
            .await?
    } else {
        store
            .append_event(
                input.session_id,
                Some(input.turn_id),
                format!("agent.{kind}"),
                payload,
            )
            .await?
    };
    if tracks_stable_message && kind == "message_start" && state.active_message_id.is_none() {
        state.active_message_id = Some(record.id);
        state.stream = Default::default();
    } else if tracks_stable_message && kind == "message_end" {
        state.active_message_id = None;
        state.stream = Default::default();
    }
    Ok(())
}

// Own the receiver so all exits disconnect producers. Cancellation also reaches
// in-flight model/tool work, even if it has not attempted its next event send.
pub(super) async fn persist_agent_events(
    store: &Store,
    input: &InputRecord,
    mut events: tokio::sync::mpsc::Receiver<AgentEvent>,
    speaker: &Value,
    orchestration: &Value,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<(), StoreError> {
    let mut state = EventPersistenceState::default();
    while let Some(event) = events.recv().await {
        let event = annotate_agent_event(event, speaker, orchestration);
        if let Err(error) = persist_agent_event(store, input, event, &mut state).await {
            events.close();
            cancellation.cancel();
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    #[tokio::test]
    async fn persistence_failure_cancels_and_disconnects_a_full_producer() {
        let store = Store::in_memory().await.unwrap();
        let session = store.create_session("failure").await.unwrap();
        let mut input = store
            .enqueue_input(session.id, eden_agent_core::TurnId::new(), json!({}))
            .await
            .unwrap()
            .input;
        input.session_id = eden_agent_core::SessionId::new();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let (emitter, events) = eden_agent_core::event_channel(2);
        let execution = async {
            for _ in 0..1000 {
                emitter.emit(AgentEvent::AgentStart).await?;
            }
            Ok::<(), eden_agent_core::AgentError>(())
        };
        let persistence = persist_agent_events(
            &store,
            &input,
            events,
            &Value::Null,
            &Value::Null,
            cancellation.clone(),
        );
        let (execution, persistence) =
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                tokio::join!(execution, persistence)
            })
            .await
            .expect("persistence failure must not hang the producer");
        assert!(matches!(
            execution,
            Err(eden_agent_core::AgentError::EventConsumerDisconnected)
        ));
        assert!(matches!(persistence, Err(StoreError::SessionNotFound(_))));
        assert!(cancellation.is_cancelled());
    }
}
