use super::message::user_message_text;
use super::{RuntimeError, RuntimeInner, process_input};
use mon_agent_core::{LoopControl, Message};
use mon_agent_domain::{SessionId, TurnId};
use mon_agent_store::{EnqueuedInput, InputRecord};
use serde_json::json;
use std::sync::Arc;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use tracing::{Instrument, error, info_span, warn};
pub(in crate::runtime) enum ActorCommand {
    Wake,
    Cancel,
    Steer {
        text: String,
        response: oneshot::Sender<Result<bool, String>>,
    },
    FollowUp {
        text: String,
        response: oneshot::Sender<Result<Option<EnqueuedInput>, String>>,
    },
    Shutdown,
}

pub(in crate::runtime) async fn session_actor(
    inner: Arc<RuntimeInner>,
    session_id: SessionId,
    mut commands: mpsc::Receiver<ActorCommand>,
) {
    type ActiveTurn = (
        CancellationToken,
        LoopControl,
        InputRecord,
        JoinHandle<Result<(), RuntimeError>>,
    );
    let mut should_claim = true;
    let mut shutting_down = false;
    let mut current: Option<ActiveTurn> = None;

    loop {
        if shutting_down {
            if let Some((_, _, _, task)) = &mut current {
                let _ = task.await;
            }
            break;
        }
        if current.is_none() && should_claim {
            should_claim = false;
            match inner.store.claim_next_input(session_id).await {
                Ok(Some(input)) => {
                    let cancellation = CancellationToken::new();
                    let control = LoopControl::default();
                    let turn_span = info_span!(
                        "session_turn",
                        session_id = %input.session_id,
                        turn_id = %input.turn_id,
                        input_id = %input.id,
                    );
                    let task = tokio::spawn(
                        process_input(
                            Arc::clone(&inner),
                            input.clone(),
                            cancellation.clone(),
                            control.clone(),
                        )
                        .instrument(turn_span),
                    );
                    current = Some((cancellation, control, input, task));
                }
                Ok(None) => {}
                Err(error) => error!(%session_id, %error, "failed to claim session input"),
            }
        }

        if let Some((cancellation, control, input, task)) = &mut current {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(ActorCommand::Wake) => should_claim = true,
                    Some(ActorCommand::Cancel) => cancellation.cancel(),
                    Some(ActorCommand::Steer { text, response }) => {
                        match inner.store.append_event(session_id, Some(input.turn_id), "turn.steered", json!({"text":text})).await {
                            Ok(_) => {
                                control.steering.enqueue(Message::user(text));
                                let _ = response.send(Ok(true));
                            }
                            Err(error) => {
                                let _ = response.send(Err(error.to_string()));
                            }
                        }
                    }
                    Some(ActorCommand::FollowUp { text, response }) => {
                        match inner.store.append_event(session_id, Some(input.turn_id), "turn.follow_up_queued", json!({"text":text})).await {
                            Ok(_) => {
                                control.follow_up.enqueue(Message::user(text));
                                let _ = response.send(Ok(None));
                            }
                            Err(error) => {
                                let _ = response.send(Err(error.to_string()));
                            }
                        }
                    }
                    Some(ActorCommand::Shutdown) | None => {
                        cancellation.cancel();
                        shutting_down = true;
                    }
                },
                result = &mut *task => {
                    match result {
                        Err(join_error) => {
                            error!(%session_id, turn_id = %input.turn_id, input_id = %input.id, %join_error, "session turn task panicked");
                            if let Ok(event) = inner.store.interrupt_input(input, join_error.to_string()).await {
                                let _ = event;
                            }
                        }
                        Ok(Err(error)) => {
                            warn!(%session_id, turn_id = %input.turn_id, input_id = %input.id, %error, "session turn failed");
                        }
                        Ok(Ok(())) => {}
                    }
                    let mut late_messages = Vec::new();
                    while control.steering.has_items() {
                        late_messages.extend(control.steering.drain());
                    }
                    while control.follow_up.has_items() {
                        late_messages.extend(control.follow_up.drain());
                    }
                    for message in late_messages {
                        if let Some(text) = user_message_text(&message) {
                            if let Err(error) = inner.store.enqueue_input(
                                session_id,
                                TurnId::new(),
                                json!({"text":text,"attachments":[],"queuedFromActiveTurn":true}),
                            ).await {
                                error!(%session_id, source_turn_id = %input.turn_id, %error, "failed to persist a late steer/follow-up message");
                            }
                        }
                    }
                    current = None;
                    should_claim = true;
                }
            }
        } else {
            match commands.recv().await {
                Some(ActorCommand::Wake) => should_claim = true,
                Some(ActorCommand::Cancel) => {}
                Some(ActorCommand::Steer { response, .. }) => {
                    let _ = response.send(Ok(false));
                }
                Some(ActorCommand::FollowUp { text, response }) => {
                    let result = inner
                        .store
                        .enqueue_input(
                            session_id,
                            TurnId::new(),
                            json!({"text":text,"attachments":[],"followUp":true}),
                        )
                        .await
                        .map(Some)
                        .map_err(|error| error.to_string());
                    if result.is_ok() {
                        should_claim = true;
                    }
                    let _ = response.send(result);
                }
                Some(ActorCommand::Shutdown) | None => break,
            }
        }
    }
}
