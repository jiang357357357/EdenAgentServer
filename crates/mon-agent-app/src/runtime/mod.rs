//! Reliable per-session orchestration around the embedded AgentCore loop.

mod actor;
mod context;
mod event;
mod message;
mod tool_policy;
mod turn;

use actor::{ActorCommand, session_actor};
use turn::process_input;

use mon_agent_blob::BlobService;
use mon_agent_core::{
    AgentError, ModelAdapter, ModelError, ModelSpec, NoopToolHooks, ToolHooks, ToolRegistry,
};
use mon_agent_domain::{SessionId, TurnId};
use mon_agent_store::{EnqueuedInput, EventRecord, SessionStatus, Store, StoreError};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};
use thiserror::Error;
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};

const ACTOR_QUEUE_CAPACITY: usize = 32;
const EVENT_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Agent(#[from] AgentError),
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error("session actor is unavailable: {0}")]
    ActorUnavailable(SessionId),
}

#[derive(Clone)]
pub struct SessionRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    store: Store,
    model_spec: ModelSpec,
    model: Arc<dyn ModelAdapter>,
    tools: ToolRegistry,
    hooks: Arc<dyn ToolHooks>,
    system_prompt: Arc<RwLock<String>>,
    blobs: Option<BlobService>,
    actors: Mutex<HashMap<SessionId, mpsc::Sender<ActorCommand>>>,
}

pub struct TurnQueueUpdate {
    pub state: &'static str,
    pub input: Option<EnqueuedInput>,
}

impl SessionRuntime {
    #[must_use]
    pub fn new(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        system_prompt: impl Into<String>,
    ) -> Self {
        Self::new_with_hooks(
            store,
            model_spec,
            model,
            tools,
            Arc::new(NoopToolHooks),
            system_prompt,
        )
    }

    #[must_use]
    pub fn new_with_hooks(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        hooks: Arc<dyn ToolHooks>,
        system_prompt: impl Into<String>,
    ) -> Self {
        Self::new_with_services(store, model_spec, model, tools, hooks, None, system_prompt)
    }

    #[must_use]
    pub fn new_with_services(
        store: Store,
        model_spec: ModelSpec,
        model: Arc<dyn ModelAdapter>,
        tools: ToolRegistry,
        hooks: Arc<dyn ToolHooks>,
        blobs: Option<BlobService>,
        system_prompt: impl Into<String>,
    ) -> Self {
        Self {
            inner: Arc::new(RuntimeInner {
                store,
                model_spec,
                model,
                tools,
                hooks,
                system_prompt: Arc::new(RwLock::new(system_prompt.into())),
                blobs,
                actors: Mutex::new(HashMap::new()),
            }),
        }
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<EventRecord> {
        self.inner.store.subscribe()
    }

    /// Replace the base prompt used by turns that start after this call.
    /// In-flight turns keep their already snapshotted prompt.
    pub fn set_system_prompt(&self, system_prompt: impl Into<String>) {
        *self
            .inner
            .system_prompt
            .write()
            .unwrap_or_else(|value| value.into_inner()) = system_prompt.into();
    }

    pub async fn submit_turn(
        &self,
        session_id: SessionId,
        text: String,
        attachments: Value,
    ) -> Result<EnqueuedInput, RuntimeError> {
        let turn_id = TurnId::new();
        let enqueued = self
            .inner
            .store
            .enqueue_input(
                session_id,
                turn_id,
                json!({"text": text, "attachments": attachments}),
            )
            .await?;
        self.send(session_id, ActorCommand::Wake).await?;
        Ok(enqueued)
    }

    pub async fn submit_job_turn(
        &self,
        session_id: SessionId,
        text: String,
        job_id: uuid::Uuid,
        job_kind: &str,
        memo_id: Option<i64>,
    ) -> Result<(), RuntimeError> {
        let turn_id = TurnId::new();
        let enqueued = self
            .inner
            .store
            .enqueue_job_input(
                session_id,
                turn_id,
                job_id,
                json!({
                    "text": text,
                    "attachments": [],
                    "jobId": job_id,
                    "jobKind": job_kind,
                    "memoId": memo_id,
                    "internalHandoff": job_kind == "assistant.handoff",
                }),
            )
            .await?;
        self.send(session_id, ActorCommand::Wake).await?;
        let _ = enqueued;
        Ok(())
    }

    pub async fn wake(&self, session_id: SessionId) -> Result<(), RuntimeError> {
        self.send(session_id, ActorCommand::Wake).await
    }

    pub async fn compact(
        &self,
        session_id: SessionId,
        instructions: String,
    ) -> Result<EnqueuedInput, RuntimeError> {
        let turn_id = TurnId::new();
        let enqueued = self
            .inner
            .store
            .enqueue_input(
                session_id,
                turn_id,
                json!({"compact":true,"instructions":instructions}),
            )
            .await?;
        self.send(session_id, ActorCommand::Wake).await?;
        Ok(enqueued)
    }

    pub async fn cancel(&self, session_id: SessionId) -> Result<(), RuntimeError> {
        self.send(session_id, ActorCommand::Cancel).await
    }

    pub async fn steer(
        &self,
        session_id: SessionId,
        text: String,
    ) -> Result<TurnQueueUpdate, RuntimeError> {
        let (response, received) = oneshot::channel();
        self.send(session_id, ActorCommand::Steer { text, response })
            .await?;
        let accepted = received
            .await
            .map_err(|_| RuntimeError::ActorUnavailable(session_id))?
            .map_err(|error| RuntimeError::Agent(AgentError::Hook(error)))?;
        if accepted {
            Ok(TurnQueueUpdate {
                state: "steered",
                input: None,
            })
        } else {
            Err(RuntimeError::Agent(AgentError::Hook(
                "session has no active turn to steer".to_owned(),
            )))
        }
    }

    pub async fn follow_up(
        &self,
        session_id: SessionId,
        text: String,
    ) -> Result<TurnQueueUpdate, RuntimeError> {
        let (response, received) = oneshot::channel();
        self.send(session_id, ActorCommand::FollowUp { text, response })
            .await?;
        let input = received
            .await
            .map_err(|_| RuntimeError::ActorUnavailable(session_id))?
            .map_err(|error| RuntimeError::Agent(AgentError::Hook(error)))?;
        Ok(TurnQueueUpdate {
            state: if input.is_some() {
                "queued"
            } else {
                "follow_up_queued"
            },
            input,
        })
    }

    pub async fn resume(&self) -> Result<(), RuntimeError> {
        for session in self.inner.store.list_sessions().await? {
            if session.status == SessionStatus::Active {
                self.send(session.id, ActorCommand::Wake).await?;
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let actors = {
            let mut actors = self.inner.actors.lock().await;
            actors.drain().map(|(_, sender)| sender).collect::<Vec<_>>()
        };
        for actor in actors {
            let _ = actor.send(ActorCommand::Shutdown).await;
        }
    }

    pub async fn forget_session(&self, session_id: SessionId) {
        if let Some(sender) = self.inner.actors.lock().await.remove(&session_id) {
            let _ = sender.send(ActorCommand::Shutdown).await;
        }
    }

    async fn send(&self, session_id: SessionId, command: ActorCommand) -> Result<(), RuntimeError> {
        let sender = self.actor_sender(session_id).await;
        sender
            .send(command)
            .await
            .map_err(|_| RuntimeError::ActorUnavailable(session_id))
    }

    async fn actor_sender(&self, session_id: SessionId) -> mpsc::Sender<ActorCommand> {
        let mut actors = self.inner.actors.lock().await;
        if let Some(sender) = actors.get(&session_id) {
            if !sender.is_closed() {
                return sender.clone();
            }
        }
        let (sender, receiver) = mpsc::channel(ACTOR_QUEUE_CAPACITY);
        actors.insert(session_id, sender.clone());
        tokio::spawn(session_actor(Arc::clone(&self.inner), session_id, receiver));
        sender
    }
}

#[cfg(test)]
mod tests;
