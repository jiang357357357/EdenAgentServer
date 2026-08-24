//! Durable, user/session-scoped projection of Eden Agent state into Mon Core.

use chrono::{TimeZone, Utc};
use eden_agent_domain::SessionId;
use eden_agent_store::{
    CoreSessionIdentityRecord, CoreSyncOutboxRecord, EventRecord, SessionRecord, SessionStatus,
    Store, StoreError,
};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::sync::{Notify, RwLock, broadcast};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};
use uuid::Uuid;

const CLAIM_LEASE_MS: i64 = 60_000;
const BATCH_SIZE: u32 = 20;

#[derive(Clone)]
pub struct CoreSyncService {
    store: Store,
    client: Client,
    credentials: Arc<RwLock<HashMap<String, CoreCredential>>>,
    notify: Arc<Notify>,
}

#[derive(Clone)]
struct CoreCredential {
    base: Url,
    token: Arc<str>,
}

/// An in-memory lease for the Core identity bound to a session.
///
/// The bearer token is deliberately neither serializable nor included in
/// `Debug`; durable consumers can borrow it without adding another secret
/// store or process-global credential path.
#[derive(Clone)]
pub struct SessionCoreCredential {
    base: Url,
    token: Arc<str>,
}

impl SessionCoreCredential {
    pub fn base_url(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl std::fmt::Debug for SessionCoreCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionCoreCredential")
            .field("base", &self.base)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum CoreSyncError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("invalid Core URL: {0}")]
    InvalidUrl(String),
    #[error("Core credential is not currently available: {0}")]
    CredentialUnavailable(String),
    #[error("Core request failed: {0}")]
    Request(String),
}

impl CoreSyncService {
    pub fn new(store: Store) -> Result<Self, CoreSyncError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("Eden Agent-CoreSync/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| CoreSyncError::Request(error.to_string()))?;
        Ok(Self {
            store,
            client,
            credentials: Arc::new(RwLock::new(HashMap::new())),
            notify: Arc::new(Notify::new()),
        })
    }

    /// Bind a Core credential to one session. Only the opaque credential
    /// reference and principal key are persisted; the token stays in memory.
    pub async fn bind_session(
        &self,
        session_id: SessionId,
        core_base_url: &str,
        core_token: &str,
    ) -> Result<CoreSessionIdentityRecord, CoreSyncError> {
        let base = normalized_base(core_base_url)?;
        let token = normalize_token(core_token);
        if token.is_empty() {
            return Err(CoreSyncError::CredentialUnavailable(
                "empty token".to_owned(),
            ));
        }
        let credential_ref = credential_ref(base.as_str(), &token);
        let credential = CoreCredential {
            base: base.clone(),
            token: Arc::from(token),
        };
        let principal_key = self
            .resolve_principal(&credential)
            .await
            .unwrap_or_else(|| format!("credential:{}", &credential_ref[..16]));
        self.credentials
            .write()
            .await
            .insert(credential_ref.clone(), credential);
        let identity = self
            .store
            .set_core_session_identity(
                session_id,
                base.as_str().trim_end_matches('/'),
                &principal_key,
                &credential_ref,
            )
            .await?;
        self.enqueue_session_snapshot(session_id).await?;
        for event in self.store.list_events(session_id, 0).await? {
            if event.event_type == "agent.message_end" {
                self.enqueue_event(&event).await?;
            }
        }
        self.notify.notify_one();
        Ok(identity)
    }

    /// Restore an environment/service credential for matching persisted
    /// identities without treating it as a process-global user identity.
    pub async fn hydrate_credential(
        &self,
        core_base_url: &str,
        core_token: &str,
    ) -> Result<String, CoreSyncError> {
        let base = normalized_base(core_base_url)?;
        let token = normalize_token(core_token);
        let reference = credential_ref(base.as_str(), &token);
        self.credentials.write().await.insert(
            reference.clone(),
            CoreCredential {
                base,
                token: Arc::from(token),
            },
        );
        self.notify.notify_one();
        Ok(reference)
    }

    /// Resolve the currently available in-memory Core credential for one
    /// session. The persisted identity contains only an opaque hash, so a
    /// restarted process must wait for the authenticated client (or service
    /// configuration) to bind the matching token again.
    pub async fn session_credential(
        &self,
        session_id: SessionId,
    ) -> Result<SessionCoreCredential, CoreSyncError> {
        let identity = self
            .store
            .get_core_session_identity(session_id)
            .await?
            .ok_or_else(|| {
                CoreSyncError::CredentialUnavailable(format!(
                    "session {session_id} has no Core identity"
                ))
            })?;
        let credential = self
            .credentials
            .read()
            .await
            .get(&identity.credential_ref)
            .cloned()
            .ok_or_else(|| CoreSyncError::CredentialUnavailable(identity.credential_ref))?;
        Ok(SessionCoreCredential {
            base: credential.base,
            token: credential.token,
        })
    }

    pub async fn enqueue_session_snapshot(
        &self,
        session_id: SessionId,
    ) -> Result<bool, CoreSyncError> {
        let Some(identity) = self.store.get_core_session_identity(session_id).await? else {
            return Ok(false);
        };
        let payload = session_projection(&self.store, session_id).await?;
        self.store
            .enqueue_core_sync(
                session_id,
                &identity.credential_ref,
                "session",
                &format!("session:{session_id}"),
                payload,
            )
            .await?;
        self.notify.notify_one();
        Ok(true)
    }

    pub async fn enqueue_event(&self, event: &EventRecord) -> Result<bool, CoreSyncError> {
        let Some(identity) = self
            .store
            .get_core_session_identity(event.session_id)
            .await?
        else {
            return Ok(false);
        };
        if event.event_type == "agent.message_end" {
            let Some(message) = event.payload.get("message") else {
                return Ok(false);
            };
            let session = self.store.get_session(event.session_id).await?;
            let message_id = stable_message_id(&self.store, event, message).await?;
            let payload = message_projection(&session, event, message, message_id);
            self.store
                .enqueue_core_sync(
                    event.session_id,
                    &identity.credential_ref,
                    "message",
                    &format!("message:{message_id}"),
                    payload,
                )
                .await?;
        } else if event.event_type == "self_awake.completed" {
            let Some(notification) = event
                .payload
                .get("notification")
                .filter(|value| !value.is_null())
                .cloned()
            else {
                return Ok(false);
            };
            let Some(run_id) = notification.get("runId").and_then(Value::as_str) else {
                return Ok(false);
            };
            self.store
                .enqueue_core_sync(
                    event.session_id,
                    &identity.credential_ref,
                    "notification",
                    &format!("self-awake-notification:{run_id}"),
                    notification,
                )
                .await?;
        } else if matches!(
            event.event_type.as_str(),
            "companion.plan"
                | "companion.speaker.started"
                | "companion.speaker.finished"
                | "companion.director.completed"
                | "companion.director.failed"
        ) {
            let Some(plan_id) = event
                .payload
                .get("planID")
                .and_then(|value| scalar(Some(value)))
            else {
                return Ok(false);
            };
            let payload = director_projection(&self.store, event.session_id, &plan_id).await?;
            self.store
                .enqueue_core_sync(
                    event.session_id,
                    &identity.credential_ref,
                    "director",
                    &format!("director:{}:{plan_id}", event.session_id),
                    payload,
                )
                .await?;
        } else if matches!(
            event.event_type.as_str(),
            "session.created"
                | "session.title_updated"
                | "session.participants_updated"
                | "session.environment_updated"
                | "session.model.bound"
                | "character.action.changed"
                | "context.compacted"
                | "turn.completed"
                | "memory.extraction_completed"
        ) {
            self.enqueue_session_snapshot(event.session_id).await?;
        } else {
            return Ok(false);
        }
        self.notify.notify_one();
        Ok(true)
    }

    /// Delete the matching Core projection before local state is removed.
    /// Returns false when this session was never bound or has no Core row.
    pub async fn delete_session_projection(
        &self,
        session_id: SessionId,
    ) -> Result<bool, CoreSyncError> {
        let Some(identity) = self.store.get_core_session_identity(session_id).await? else {
            return Ok(false);
        };
        let credential = self
            .credentials
            .read()
            .await
            .get(&identity.credential_ref)
            .cloned()
            .ok_or_else(|| CoreSyncError::CredentialUnavailable(identity.credential_ref.clone()))?;
        let response = self
            .request(
                &credential,
                Method::GET,
                &format!("/api/agent/sessions/?external_session_id={session_id}&limit=1"),
                None,
            )
            .await?;
        let records = response
            .as_array()
            .or_else(|| response.get("results").and_then(Value::as_array))
            .or_else(|| response.get("items").and_then(Value::as_array));
        let Some(core_id) = records
            .and_then(|records| records.first())
            .and_then(|record| scalar(record.get("id")))
        else {
            return Ok(false);
        };
        self.request(
            &credential,
            Method::DELETE,
            &format!("/api/agent/sessions/{core_id}/"),
            None,
        )
        .await?;
        Ok(true)
    }

    pub async fn process_once(&self) -> Result<usize, CoreSyncError> {
        let records = self
            .store
            .claim_core_sync(BATCH_SIZE, CLAIM_LEASE_MS)
            .await?;
        let count = records.len();
        for record in records {
            match self.deliver(&record).await {
                Ok(()) => {
                    self.store.complete_core_sync(record.id).await?;
                    if record.kind == "notification"
                        && let Some(run_id) = record
                            .payload
                            .get("runId")
                            .and_then(Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                    {
                        self.store
                            .update_self_awake_notification(
                                run_id,
                                "delivered",
                                Some(json!({"deliveredBy":"core_email"})),
                                None,
                            )
                            .await?;
                    }
                }
                Err(error) => {
                    let delay = retry_delay_ms(record.attempts);
                    warn!(
                        %error,
                        outbox_id = record.id,
                        session_id = %record.session_id,
                        attempts = record.attempts + 1,
                        delay_ms = delay,
                        "Core projection failed; queued for retry"
                    );
                    self.store
                        .retry_core_sync(record.id, &error.to_string(), delay)
                        .await?;
                    if record.kind == "notification"
                        && let Some(run_id) = record
                            .payload
                            .get("runId")
                            .and_then(Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                    {
                        self.store
                            .update_self_awake_notification(
                                run_id,
                                "pending",
                                None,
                                Some(&error.to_string()),
                            )
                            .await?;
                    }
                }
            }
        }
        Ok(count)
    }

    pub async fn run(self, cancellation: CancellationToken) {
        self.run_inner(cancellation, None).await;
    }

    pub async fn run_with_heartbeat(
        self,
        cancellation: CancellationToken,
        heartbeat: Arc<AtomicI64>,
    ) {
        self.run_inner(cancellation, Some(heartbeat)).await;
    }

    async fn run_inner(self, cancellation: CancellationToken, heartbeat: Option<Arc<AtomicI64>>) {
        let mut events = self.store.subscribe();
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = self.notify.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                received = events.recv() => match received {
                    Ok(event) => {
                        if let Err(error) = self.enqueue_event(&event).await {
                            warn!(%error, event_id=%event.id, "failed to enqueue Core projection");
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "Core projection observer lagged; session snapshots will self-heal");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
            if let Some(heartbeat) = heartbeat.as_ref() {
                heartbeat.store(epoch_millis(), Ordering::Relaxed);
            }
            if let Err(error) = self.process_once().await {
                warn!(%error, "Core projection worker iteration failed");
            }
        }
    }

    async fn resolve_principal(&self, credential: &CoreCredential) -> Option<String> {
        let response = self
            .request(credential, Method::GET, "/api/users/me/profile/", None)
            .await
            .ok()?;
        scalar(response.get("id"))
            .or_else(|| response.get("user").and_then(|user| scalar(user.get("id"))))
            .or_else(|| scalar(response.get("username")))
            .map(|value| format!("user:{value}"))
    }

    async fn deliver(&self, record: &CoreSyncOutboxRecord) -> Result<(), CoreSyncError> {
        let credential = self
            .credentials
            .read()
            .await
            .get(&record.credential_ref)
            .cloned()
            .ok_or_else(|| CoreSyncError::CredentialUnavailable(record.credential_ref.clone()))?;
        match record.kind.as_str() {
            "session" => {
                let session_map = self
                    .request(
                        &credential,
                        Method::POST,
                        "/api/agent/sessions/",
                        Some(record.payload.clone()),
                    )
                    .await?;
                if let (Some(core_id), Some(assistant_ids)) = (
                    scalar(session_map.get("id")),
                    record
                        .payload
                        .get("session_payload")
                        .and_then(|payload| payload.get("participantAssistantIDs"))
                        .and_then(Value::as_array),
                ) {
                    self.request(
                        &credential,
                        Method::PUT,
                        &format!("/api/agent/sessions/{core_id}/participants/"),
                        Some(json!({"assistant_ids":assistant_ids,"mode":"companion"})),
                    )
                    .await?;
                }
            }
            "message" => {
                let session = record.payload.get("session").cloned().ok_or_else(|| {
                    CoreSyncError::Request("message projection has no session".to_owned())
                })?;
                let message = record.payload.get("message").cloned().ok_or_else(|| {
                    CoreSyncError::Request("message projection has no message".to_owned())
                })?;
                let session_map = self
                    .request(
                        &credential,
                        Method::POST,
                        "/api/agent/sessions/",
                        Some(session),
                    )
                    .await?;
                let core_id = scalar(session_map.get("id")).ok_or_else(|| {
                    CoreSyncError::Request("Core session response has no id".to_owned())
                })?;
                let response = self
                    .request(
                        &credential,
                        Method::POST,
                        &format!("/api/agent/sessions/{core_id}/messages/"),
                        Some(message),
                    )
                    .await?;
                if response.get("sync_status").and_then(Value::as_str) == Some("failed") {
                    return Err(CoreSyncError::Request(
                        "Core stored the raw message but its projection failed".to_owned(),
                    ));
                }
            }
            "director" => {
                let session = record.payload.get("session").cloned().ok_or_else(|| {
                    CoreSyncError::Request("director projection has no session".to_owned())
                })?;
                let director = record.payload.get("director").cloned().ok_or_else(|| {
                    CoreSyncError::Request("director projection has no run".to_owned())
                })?;
                let session_map = self
                    .request(
                        &credential,
                        Method::POST,
                        "/api/agent/sessions/",
                        Some(session),
                    )
                    .await?;
                let core_id = scalar(session_map.get("id")).ok_or_else(|| {
                    CoreSyncError::Request("Core session response has no id".to_owned())
                })?;
                self.request(
                    &credential,
                    Method::POST,
                    &format!("/api/agent/sessions/{core_id}/director-runs/"),
                    Some(director),
                )
                .await?;
            }
            "notification" => {
                let title = record
                    .payload
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Eden Agent 提醒");
                let message = record
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        CoreSyncError::Request("notification has no message".to_owned())
                    })?;
                self.request(
                    &credential,
                    Method::POST,
                    "/api/agent/external-email/send/",
                    Some(json!({"subject":title,"content":message})),
                )
                .await?;
            }
            other => {
                return Err(CoreSyncError::Request(format!(
                    "unsupported Core projection kind: {other}"
                )));
            }
        }
        debug!(outbox_id = record.id, kind = %record.kind, "Core projection completed");
        Ok(())
    }

    async fn request(
        &self,
        credential: &CoreCredential,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreSyncError> {
        let url = credential
            .base
            .join(path.trim_start_matches('/'))
            .map_err(|error| CoreSyncError::InvalidUrl(error.to_string()))?;
        let mut request = self.client.request(method, url).header(
            reqwest::header::AUTHORIZATION,
            if credential.token.starts_with("Token ") || credential.token.starts_with("Bearer ") {
                credential.token.to_string()
            } else {
                format!("Token {}", credential.token)
            },
        );
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| CoreSyncError::Request(error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CoreSyncError::Request(error.to_string()))?;
        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
            json!({"detail":String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>()})
        });
        if !status.is_success() {
            return Err(CoreSyncError::Request(format!(
                "{}: {}",
                status,
                value
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("Mon Core request failed")
            )));
        }
        Ok(value)
    }
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

async fn session_projection(store: &Store, session_id: SessionId) -> Result<Value, StoreError> {
    let session = store.get_session(session_id).await?;
    let events = store.list_events(session_id, 0).await?;
    let assistant_id = participant_id(&session, "assistantId", "assistant", "id");
    let character_id = participant_id(&session, "characterId", "character", "id");
    let canonical_context = events
        .iter()
        .rev()
        .find(|event| event.event_type == "context.compacted")
        .map(|event| event.payload.clone());
    let character_runtime = events
        .iter()
        .rev()
        .find(|event| event.event_type == "character.action.changed")
        .map(|event| event.payload.clone());
    let mut selected_events = events
        .iter()
        .rev()
        .filter(|event| {
            !event.event_type.contains("delta") && !event.event_type.contains("thinking")
        })
        .take(200)
        .collect::<Vec<_>>();
    selected_events.reverse();
    let event_payload = selected_events
        .into_iter()
        .map(|event| {
            json!({
                "id":event.id,
                "seq":event.seq,
                "turnId":event.turn_id,
                "type":event.event_type,
                "payload":event.payload,
                "createdAt":event.created_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "source":"edenagent",
        "external_session_id":session.id,
        "assistant":assistant_id,
        "character":character_id,
        "title":session.title,
        "mode":"companion",
        "director_policy":{},
        "session_payload":{
            "id":session.id,
            "title":session.title,
            "status":session.status,
            "participants":session.participants,
            "environment":session.environment,
            "participantAssistantIDs":session.participants.iter().filter_map(|participant|scalar(participant.get("assistantId"))).collect::<Vec<_>>(),
            "canonicalContext":canonical_context,
            "characterRuntime":character_runtime,
            "time":{"created":session.created_at,"updated":session.updated_at},
        },
        "session_events_payload":event_payload,
        "status":if session.status == SessionStatus::Closed {"closed"} else {"active"},
        "last_message_at":timestamp_iso(session.updated_at),
    }))
}

async fn stable_message_id(
    store: &Store,
    event: &EventRecord,
    message: &Value,
) -> Result<Uuid, StoreError> {
    if let Some(message_id) = event
        .payload
        .get("messageId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
    {
        return Ok(message_id);
    }
    let role = message.get("role").and_then(Value::as_str);
    if role == Some("toolResult") {
        return Ok(event.id);
    }
    let events = store.list_events(event.session_id, 0).await?;
    let mut message_start_id = None;
    for candidate in events
        .iter()
        .filter(|candidate| candidate.seq < event.seq && candidate.turn_id == event.turn_id)
    {
        let candidate_role = candidate
            .payload
            .get("message")
            .and_then(|value| value.get("role"))
            .and_then(Value::as_str);
        if candidate.event_type == "agent.message_end" && candidate_role != Some("toolResult") {
            message_start_id = None;
        }
        if candidate.event_type == "agent.message_start"
            && candidate_role == role
            && message_start_id.is_none()
        {
            message_start_id = Some(candidate.id);
        }
    }
    Ok(message_start_id.unwrap_or(event.id))
}

fn message_projection(
    session: &SessionRecord,
    event: &EventRecord,
    message: &Value,
    message_id: Uuid,
) -> Value {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let assistant_id = participant_id(session, "assistantId", "assistant", "id");
    let character_id = participant_id(session, "characterId", "character", "id");
    json!({
        "session":{
            "source":"edenagent",
            "external_session_id":session.id,
            "assistant":assistant_id,
            "character":character_id,
            "title":session.title,
            "mode":"companion",
            "director_policy":{},
            "session_payload":{
                "id":session.id,"title":session.title,"participants":session.participants,
                "environment":session.environment,
                "participantAssistantIDs":session.participants.iter().filter_map(|participant|scalar(participant.get("assistantId"))).collect::<Vec<_>>(),
                "time":{"created":session.created_at,"updated":session.updated_at}
            },
            "session_events_payload":[],
            "status":"active",
            "last_message_at":timestamp_iso(event.created_at),
        },
        "message":{
            "external_message_id":message_id,
            "external_parent_message_id":"",
            "kind":if role=="user" {"user"} else {"assistant"},
            "message_payload":{
                "info":{
                    "id":message_id,
                    "role":role,
                    "time":{"created":event.created_at,"completed":event.created_at},
                    "speaker":if role=="assistant" {json!({"assistantID":assistant_id,"characterID":character_id})} else {Value::Null},
                    "turnID":event.turn_id,
                },
                "message":message,
                "parts":message.get("content").cloned().unwrap_or_else(||json!([])),
            },
            "speaker_assistant":if role=="assistant" {assistant_id} else {None},
            "speaker_character":if role=="assistant" {character_id} else {None},
            "turn_index":Value::Null,
            "orchestration_payload":{},
            "tool_call_id":"",
            "sync_status":"synced",
        }
    })
}

async fn director_projection(
    store: &Store,
    session_id: SessionId,
    plan_id: &str,
) -> Result<Value, StoreError> {
    let session = store.get_session(session_id).await?;
    let events = store.list_events(session_id, 0).await?;
    let plan = events
        .iter()
        .find(|event| {
            event.event_type == "companion.plan"
                && event
                    .payload
                    .get("planID")
                    .and_then(|value| scalar(Some(value)))
                    .as_deref()
                    == Some(plan_id)
        })
        .map(|event| event.payload.clone())
        .unwrap_or_else(|| json!({}));
    let related = events
        .iter()
        .filter(|event| {
            event
                .payload
                .get("planID")
                .and_then(|value| scalar(Some(value)))
                .as_deref()
                == Some(plan_id)
        })
        .collect::<Vec<_>>();
    let completed = related
        .iter()
        .filter(|event| event.event_type == "companion.speaker.finished")
        .filter_map(|event| event.payload.get("beatIndex").and_then(Value::as_u64))
        .collect::<Vec<_>>();
    let last = related.last();
    let status = match last.map(|event| event.event_type.as_str()) {
        Some("companion.director.completed") => "completed",
        Some("companion.director.failed") => "failed",
        Some("companion.speaker.started" | "companion.speaker.finished") => "running",
        _ => "planned",
    };
    let active = last
        .filter(|event| event.event_type == "companion.speaker.started")
        .and_then(|event| event.payload.get("beatIndex"))
        .cloned();
    let assistant_id = participant_id(&session, "assistantId", "assistant", "id");
    let character_id = participant_id(&session, "characterId", "character", "id");
    Ok(json!({
        "session":{
            "source":"edenagent","external_session_id":session.id,"assistant":assistant_id,
            "character":character_id,"title":session.title,"mode":"companion","director_policy":{},
            "session_payload":{"id":session.id,"title":session.title,"participants":session.participants,
                "environment":session.environment,
                "participantAssistantIDs":session.participants.iter().filter_map(|participant|scalar(participant.get("assistantId"))).collect::<Vec<_>>(),
                "time":{"created":session.created_at,"updated":session.updated_at}},
            "session_events_payload":[],"status":"active","last_message_at":timestamp_iso(session.updated_at)
        },
        "director":{
            "external_plan_id":plan_id,
            "external_user_message_id":plan.get("userMessageID"),
            "source":plan.get("source").and_then(Value::as_str).unwrap_or(""),
            "diagnostic":plan.get("diagnostic"),
            "scene_payload":plan.get("scene").cloned().unwrap_or_else(||json!({})),
            "execution_payload":plan.get("execution").cloned().unwrap_or_else(||json!({})),
            "beats_payload":plan.get("beats").cloned().unwrap_or_else(||json!([])),
            "status":status,
            "active_beat_index":active,
            "completed_beat_indexes":completed,
            "participant_count":session.participants.len(),
            "error":last.and_then(|event|event.payload.get("error")).cloned(),
        }
    }))
}

fn participant_id(
    session: &SessionRecord,
    direct_key: &str,
    nested_key: &str,
    nested_id: &str,
) -> Option<String> {
    session
        .participants
        .first()
        .and_then(|participant| scalar(participant.get(direct_key)))
        .or_else(|| {
            session
                .participants
                .first()
                .and_then(|participant| participant.get("profile"))
                .and_then(|profile| profile.get(nested_key))
                .and_then(|value| scalar(value.get(nested_id)))
        })
}

fn normalized_base(value: &str) -> Result<Url, CoreSyncError> {
    let value = format!("{}/", value.trim().trim_end_matches('/'));
    let url = Url::parse(&value).map_err(|error| CoreSyncError::InvalidUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreSyncError::InvalidUrl(
            "Core URL must use HTTP(S)".to_owned(),
        ));
    }
    Ok(url)
}

fn normalize_token(value: &str) -> String {
    value
        .trim()
        .strip_prefix("Token ")
        .or_else(|| value.trim().strip_prefix("Bearer "))
        .unwrap_or(value.trim())
        .trim()
        .to_owned()
}

fn credential_ref(base: &str, token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(base.as_bytes());
    digest.update([0]);
    digest.update(token.as_bytes());
    format!("core:{}", hex::encode(digest.finalize()))
}

fn scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn retry_delay_ms(attempts: i64) -> i64 {
    let exponent = u32::try_from(attempts.clamp(0, 8)).unwrap_or_default();
    (1_000_i64.saturating_mul(2_i64.saturating_pow(exponent))).min(300_000)
}

fn timestamp_iso(millis: i64) -> String {
    Utc.timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_domain::TurnId;

    #[test]
    fn credential_reference_is_stable_and_does_not_contain_token() {
        let reference = credential_ref("https://core.example/", "secret-token");
        assert_eq!(
            reference,
            credential_ref("https://core.example/", "secret-token")
        );
        assert!(!reference.contains("secret-token"));
    }

    #[tokio::test]
    async fn session_credential_uses_the_bound_identity_and_redacts_the_token() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("credential").await.expect("session");
        let service = CoreSyncService::new(store.clone()).expect("service");
        let reference = service
            .hydrate_credential("https://core.example/", "Bearer secret-token")
            .await
            .expect("hydrate");
        store
            .set_core_session_identity(session.id, "https://core.example", "user:1", &reference)
            .await
            .expect("identity");

        let credential = service
            .session_credential(session.id)
            .await
            .expect("credential");
        assert_eq!(credential.base_url(), "https://core.example");
        assert_eq!(credential.token(), "secret-token");
        let diagnostic = format!("{credential:?}");
        assert!(diagnostic.contains("[REDACTED]"));
        assert!(!diagnostic.contains("secret-token"));
    }

    #[tokio::test]
    async fn session_credential_reports_a_recoverable_missing_binding() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("credential").await.expect("session");
        let service = CoreSyncService::new(store).expect("service");

        assert!(matches!(
            service.session_credential(session.id).await,
            Err(CoreSyncError::CredentialUnavailable(_))
        ));
    }

    #[test]
    fn retry_delay_is_bounded() {
        assert_eq!(retry_delay_ms(0), 1_000);
        assert_eq!(retry_delay_ms(1), 2_000);
        assert!(retry_delay_ms(100) <= 300_000);
    }

    #[tokio::test]
    async fn projections_include_participants_context_character_state_and_messages() {
        let store = Store::in_memory().await.expect("store");
        let session = store
            .create_session_with_participants(
                "projection",
                vec![json!({"assistantId":3,"characterId":7})],
            )
            .await
            .expect("session");
        store
            .append_event(
                session.id,
                None,
                "context.compacted",
                json!({"summary":"canonical"}),
            )
            .await
            .expect("context");
        store
            .append_event(
                session.id,
                None,
                "character.action.changed",
                json!({"characterId":7,"action":{"name":"微笑"}}),
            )
            .await
            .expect("action");
        let message_start = store
            .append_event(
                session.id,
                Some(TurnId::new()),
                "agent.message_start",
                json!({"message":{"role":"assistant","content":[{"type":"text","text":""}]}}),
            )
            .await
            .expect("message start");
        store
            .append_event(
                session.id,
                message_start.turn_id,
                "agent.message_start",
                json!({"message":{"role":"assistant","content":[{"type":"text","text":""}]}}),
            )
            .await
            .expect("retry message start");
        let message = store
            .append_event(
                session.id,
                message_start.turn_id,
                "agent.message_end",
                json!({"message":{"role":"assistant","content":[{"type":"text","text":"你好"}]}}),
            )
            .await
            .expect("message");
        store
            .set_core_session_identity(session.id, "https://core.example", "user:1", "credential:1")
            .await
            .expect("identity");
        let service = CoreSyncService::new(store.clone()).expect("service");
        assert!(
            service
                .enqueue_session_snapshot(session.id)
                .await
                .expect("snapshot")
        );
        assert!(
            service
                .enqueue_event(&message)
                .await
                .expect("message projection")
        );
        let queued = store
            .list_core_sync_outbox(Some("queued"), 10)
            .await
            .expect("outbox");
        assert_eq!(queued.len(), 2);
        let session_payload = &queued
            .iter()
            .find(|item| item.kind == "session")
            .expect("session item")
            .payload;
        assert_eq!(session_payload["assistant"], "3");
        assert_eq!(session_payload["character"], "7");
        assert_eq!(
            session_payload["session_payload"]["canonicalContext"]["summary"],
            "canonical"
        );
        assert_eq!(
            session_payload["session_payload"]["characterRuntime"]["action"]["name"],
            "微笑"
        );
        let message_payload = &queued
            .iter()
            .find(|item| item.kind == "message")
            .expect("message item")
            .payload;
        assert_eq!(message_payload["message"]["kind"], "assistant");
        assert_eq!(
            message_payload["message"]["external_message_id"],
            message_start.id.to_string()
        );
        assert_eq!(
            message_payload["message"]["message_payload"]["info"]["id"],
            message_start.id.to_string()
        );
        assert_eq!(
            message_payload["message"]["message_payload"]["parts"][0]["text"],
            "你好"
        );
    }

    #[tokio::test]
    async fn self_awake_notification_is_enqueued_once() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("notification").await.expect("session");
        store
            .set_core_session_identity(session.id, "https://core.example", "user:1", "credential:1")
            .await
            .expect("identity");
        let run_id = Uuid::now_v7();
        let event = store
            .append_event(
                session.id,
                Some(TurnId::new()),
                "self_awake.completed",
                json!({
                    "runId":run_id,
                    "notification":{
                        "runId":run_id,
                        "title":"提醒",
                        "message":"该休息了",
                        "channel":"auto"
                    }
                }),
            )
            .await
            .expect("event");
        let service = CoreSyncService::new(store.clone()).expect("service");
        assert!(service.enqueue_event(&event).await.expect("enqueue"));
        assert!(service.enqueue_event(&event).await.expect("dedupe enqueue"));
        let queued = store
            .list_core_sync_outbox(Some("queued"), 10)
            .await
            .expect("outbox");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].kind, "notification");
        assert_eq!(queued[0].payload["message"], "该休息了");
    }
}
