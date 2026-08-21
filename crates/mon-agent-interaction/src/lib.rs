//! Durable model-to-user question requests.

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use mon_agent_blob::{BlobError, BlobService};
use mon_agent_core::{Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput};
use mon_agent_domain::{QuestionRequestId, SessionId, TurnId};
use mon_agent_store::{MediaRequestRecord, QuestionRecord, Store, StoreError};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use thiserror::Error;
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

type MediaResolution = (Option<Value>, Option<String>);
type PendingMedia = Arc<Mutex<HashMap<Uuid, oneshot::Sender<MediaResolution>>>>;
type QuestionResolution = Result<Value, String>;

#[derive(Debug, Error)]
pub enum QuestionError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    #[error("invalid media response: {0}")]
    InvalidMedia(String),
}

#[derive(Clone)]
pub struct QuestionService {
    store: Store,
    pending: Arc<Mutex<HashMap<QuestionRequestId, oneshot::Sender<QuestionResolution>>>>,
}

impl QuestionService {
    #[must_use]
    pub fn new(store: Store) -> Self {
        Self {
            store,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn list_pending(
        &self,
        session_id: Option<SessionId>,
    ) -> Result<Vec<QuestionRecord>, QuestionError> {
        Ok(self.store.list_pending_questions(session_id).await?)
    }

    pub async fn resolve(
        &self,
        request_id: QuestionRequestId,
        answers: Vec<Vec<String>>,
    ) -> Result<QuestionRecord, QuestionError> {
        let answers = serde_json::to_value(answers).expect("answers serialize");
        let mutation = self
            .store
            .resolve_question(request_id, answers.clone())
            .await?;
        if let Some(waiter) = self.pending.lock().await.remove(&request_id) {
            let _ = waiter.send(Ok(answers));
        }
        Ok(mutation.question)
    }

    pub async fn reject(
        &self,
        request_id: QuestionRequestId,
    ) -> Result<QuestionRecord, QuestionError> {
        let mutation = self.store.reject_question(request_id).await?;
        if let Some(waiter) = self.pending.lock().await.remove(&request_id) {
            let _ = waiter.send(Err("user declined to answer the question".to_owned()));
        }
        Ok(mutation.question)
    }
}

#[async_trait]
impl Tool for QuestionService {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "request_user_input",
            "Ask the user one to three short questions and wait for their answers",
        );
        definition.parameters = json!({
            "type": "object",
            "required": ["questions"],
            "properties": {
                "questions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "required": ["header", "question", "options"],
                        "properties": {
                            "header": {"type": "string", "maxLength": 24},
                            "question": {"type": "string"},
                            "multiple": {"type": "boolean"},
                            "options": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 3,
                                "items": {
                                    "type": "object",
                                    "required": ["label", "description"],
                                    "properties": {
                                        "label": {"type": "string"},
                                        "description": {"type": "string"}
                                    },
                                    "additionalProperties": false
                                }
                            }
                        },
                        "additionalProperties": false
                    }
                }
            },
            "additionalProperties": false
        });
        definition
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let session_id = context
            .session_id
            .as_deref()
            .ok_or_else(|| ToolFailure::new("question_context_missing", "missing session ID"))?
            .parse::<SessionId>()
            .map_err(|_| ToolFailure::new("question_context_invalid", "invalid session ID"))?;
        let turn_id = context
            .metadata
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolFailure::new("question_context_missing", "missing turn ID"))?
            .parse::<TurnId>()
            .map_err(|_| ToolFailure::new("question_context_invalid", "invalid turn ID"))?;
        let questions = call
            .arguments
            .get("questions")
            .cloned()
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "questions are required"))?;
        let request_id = QuestionRequestId::new();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id, sender);
        if let Err(error) = self
            .store
            .create_question(request_id, session_id, turn_id, questions)
            .await
        {
            self.pending.lock().await.remove(&request_id);
            return Err(ToolFailure::new("question_store_failed", error.to_string()));
        }
        let resolution = tokio::select! {
            _ = context.cancellation.cancelled() => {
                self.pending.lock().await.remove(&request_id);
                return Err(ToolFailure::new("aborted", "question request cancelled"));
            }
            resolution = receiver => resolution.map_err(|_| {
                ToolFailure::new("question_unavailable", "question request was abandoned")
            })?,
        };
        let answers =
            resolution.map_err(|message| ToolFailure::new("question_rejected", message))?;
        Ok(ToolOutput {
            content: vec![mon_agent_core::ContentBlock::Text {
                text: format!("User answered: {answers}"),
            }],
            structured_content: Some(json!({
                "requestId": request_id,
                "answers": answers,
            })),
            success: true,
            ..ToolOutput::default()
        })
    }
}

#[derive(Clone)]
pub struct MediaService {
    store: Store,
    blobs: BlobService,
    pending: PendingMedia,
}

impl MediaService {
    #[must_use]
    pub fn new(store: Store, blobs: BlobService) -> Self {
        Self {
            store,
            blobs,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn list_pending(
        &self,
        kind: Option<&str>,
    ) -> Result<Vec<MediaRequestRecord>, QuestionError> {
        Ok(self.store.list_pending_media_requests(kind).await?)
    }

    pub async fn resolve(
        &self,
        id: Uuid,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<MediaRequestRecord, QuestionError> {
        if result.is_some() == error.is_some() {
            return Err(QuestionError::InvalidMedia(
                "provide exactly one of result or error".to_owned(),
            ));
        }
        let pending = self.store.get_media_request(id).await?;
        if pending.state != "pending" {
            return Err(QuestionError::InvalidMedia(
                "media request is not pending".to_owned(),
            ));
        }
        if let Some(result) = result.as_ref() {
            validate_media_result(&self.blobs, &pending, result).await?;
        }
        let record = self
            .store
            .resolve_media_request(id, result.clone(), error.clone())
            .await?;
        if let Some(waiter) = self.pending.lock().await.remove(&id) {
            let _ = waiter.send((result, error));
        }
        Ok(record)
    }

    #[must_use]
    pub fn tools(&self) -> [Arc<dyn Tool>; 2] {
        [
            Arc::new(MediaCaptureTool {
                service: self.clone(),
                kind: "screen",
            }),
            Arc::new(MediaCaptureTool {
                service: self.clone(),
                kind: "camera",
            }),
        ]
    }
}

struct MediaCaptureTool {
    service: MediaService,
    kind: &'static str,
}

#[async_trait]
impl Tool for MediaCaptureTool {
    fn definition(&self) -> ToolDefinition {
        let (name, description) = if self.kind == "screen" {
            (
                "analyze_screen",
                "Request a desktop screenshot from the authenticated client",
            )
        } else {
            (
                "capture_camera",
                "Request a camera frame from the authenticated client",
            )
        };
        let mut value = ToolDefinition::direct(name, description);
        value.parameters = if self.kind == "screen" {
            json!({
                "type":"object",
                "properties":{
                    "source":{"type":"string","enum":["auto","desktop","game"]},
                    "prompt":{"type":"string","maxLength":2000}
                },
                "additionalProperties":false
            })
        } else {
            json!({
                "type":"object",
                "properties":{
                    "facingMode":{"type":"string","enum":["user","environment"]},
                    "prompt":{"type":"string","maxLength":2000}
                },
                "additionalProperties":false
            })
        };
        value
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        validate_media_arguments(self.kind, &call.arguments)?;
        let session_id = context
            .session_id
            .as_deref()
            .ok_or_else(|| ToolFailure::new("missing_session", "media capture requires a session"))?
            .parse::<SessionId>()
            .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))?;
        let turn_id = context
            .metadata
            .get("turnId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolFailure::new("missing_turn", "media capture requires a turn"))?
            .parse::<TurnId>()
            .map_err(|error| ToolFailure::new("invalid_turn", error.to_string()))?;
        let record = self
            .service
            .store
            .create_media_request(session_id, turn_id, self.kind, call.arguments.clone())
            .await
            .map_err(|error| ToolFailure::new("media_request_failed", error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.service.pending.lock().await.insert(record.id, sender);
        let persisted = self
            .service
            .store
            .get_media_request(record.id)
            .await
            .map_err(|error| ToolFailure::new("media_request_failed", error.to_string()))?;
        let (result, error) = if persisted.state != "pending" {
            self.service.pending.lock().await.remove(&record.id);
            (persisted.result, persisted.error)
        } else {
            tokio::select! {
                _ = context.cancellation.cancelled() => {
                    self.service.pending.lock().await.remove(&record.id);
                    let _ = self.service.store.resolve_media_request(
                        record.id,
                        None,
                        Some("media request cancelled".to_owned()),
                    ).await;
                    return Err(ToolFailure::new("aborted", "media request cancelled"));
                }
                value = receiver => match value {
                    Ok(value) => value,
                    Err(_) => {
                        let _ = self.service.store.resolve_media_request(
                            record.id,
                            None,
                            Some("media request was abandoned".to_owned()),
                        ).await;
                        return Err(ToolFailure::new(
                            "media_unavailable",
                            "media request was abandoned",
                        ));
                    }
                }
            }
        };
        if let Some(error) = error {
            return Err(ToolFailure::new("media_rejected", error));
        }
        let result =
            result.ok_or_else(|| ToolFailure::new("media_rejected", "capture was rejected"))?;
        let blob_id = result
            .get("blobId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ToolFailure::new("invalid_media_result", "capture result has no blobId")
            })?
            .parse()
            .map_err(|error| ToolFailure::new("invalid_blob_id", format!("{error}")))?;
        let (blob, bytes) = self
            .service
            .blobs
            .read(blob_id)
            .await
            .map_err(|error| ToolFailure::new("blob_read_failed", error.to_string()))?;
        Ok(ToolOutput {
            content: vec![
                mon_agent_core::ContentBlock::Text {
                    text: format!("Captured {} image", self.kind),
                },
                mon_agent_core::ContentBlock::Image {
                    data: BASE64.encode(bytes),
                    mime_type: blob.mime,
                    source: Some(json!({"type":"blob","blobId":blob.id})),
                },
            ],
            details: result,
            success: true,
            ..ToolOutput::default()
        })
    }
}

fn validate_media_arguments(kind: &str, arguments: &Value) -> Result<(), ToolFailure> {
    let object = arguments.as_object().ok_or_else(|| {
        ToolFailure::new("invalid_arguments", "media arguments must be an object")
    })?;
    let allowed = if kind == "screen" {
        &["source", "prompt"][..]
    } else {
        &["facingMode", "prompt"][..]
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(ToolFailure::new(
            "invalid_arguments",
            format!("unsupported media argument: {key}"),
        ));
    }
    if let Some(prompt) = object.get("prompt") {
        let prompt = prompt
            .as_str()
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "prompt must be a string"))?;
        if prompt.chars().count() > 2_000 {
            return Err(ToolFailure::new(
                "invalid_arguments",
                "prompt exceeds 2000 characters",
            ));
        }
    }
    if kind == "screen" {
        if let Some(source) = object.get("source") {
            let source = source
                .as_str()
                .filter(|value| matches!(*value, "auto" | "desktop" | "game"))
                .ok_or_else(|| {
                    ToolFailure::new(
                        "invalid_arguments",
                        "screen source must be auto, desktop, or game",
                    )
                })?;
            let _ = source;
        }
    } else if let Some(facing_mode) = object.get("facingMode") {
        let facing_mode = facing_mode
            .as_str()
            .filter(|value| matches!(*value, "user" | "environment"))
            .ok_or_else(|| {
                ToolFailure::new(
                    "invalid_arguments",
                    "camera facingMode must be user or environment",
                )
            })?;
        let _ = facing_mode;
    }
    Ok(())
}

async fn validate_media_result(
    blobs: &BlobService,
    request: &MediaRequestRecord,
    result: &Value,
) -> Result<(), QuestionError> {
    let object = result.as_object().ok_or_else(|| {
        QuestionError::InvalidMedia("capture result must be an object".to_owned())
    })?;
    let blob_id = object
        .get("blobId")
        .and_then(Value::as_str)
        .ok_or_else(|| QuestionError::InvalidMedia("capture result has no blobId".to_owned()))?
        .parse()
        .map_err(|_| QuestionError::InvalidMedia("capture blobId is invalid".to_owned()))?;
    let width = positive_image_dimension(object.get("width"), "width")?;
    let height = positive_image_dimension(object.get("height"), "height")?;
    if width > 32_768 || height > 32_768 {
        return Err(QuestionError::InvalidMedia(
            "capture dimensions exceed 32768 pixels".to_owned(),
        ));
    }
    let (blob, bytes) = blobs.read(blob_id).await?;
    let detected = detect_image_mime(&bytes).ok_or_else(|| {
        QuestionError::InvalidMedia("capture blob is not a supported raster image".to_owned())
    })?;
    if normalize_image_mime(&blob.mime) != Some(detected) {
        return Err(QuestionError::InvalidMedia(
            "capture blob MIME does not match its content".to_owned(),
        ));
    }
    if let Some(declared) = object.get("mime").and_then(Value::as_str)
        && normalize_image_mime(declared) != Some(detected)
    {
        return Err(QuestionError::InvalidMedia(
            "capture result MIME does not match its blob".to_owned(),
        ));
    }
    match request.kind.as_str() {
        "screen" => {
            if let Some(source) = object.get("source").and_then(Value::as_str)
                && !matches!(source, "desktop" | "game")
            {
                return Err(QuestionError::InvalidMedia(
                    "screen result source must be desktop or game".to_owned(),
                ));
            }
        }
        "camera" => {
            if let Some(facing_mode) = object.get("facingMode").and_then(Value::as_str)
                && !facing_mode.is_empty()
                && !matches!(facing_mode, "user" | "environment")
            {
                return Err(QuestionError::InvalidMedia(
                    "camera result facingMode must be user or environment".to_owned(),
                ));
            }
        }
        _ => {
            return Err(QuestionError::InvalidMedia(
                "unsupported media request kind".to_owned(),
            ));
        }
    }
    Ok(())
}

fn positive_image_dimension(value: Option<&Value>, name: &str) -> Result<u64, QuestionError> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            QuestionError::InvalidMedia(format!("capture {name} must be a positive integer"))
        })
}

fn normalize_image_mime(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_core::{ContentBlock, ToolCall, ToolCallContext, event_channel};
    use tokio_util::sync::CancellationToken;

    async fn media_fixture() -> (Store, SessionId, TurnId, MediaService) {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("media").await.expect("session");
        let directory = tempfile::tempdir().expect("blob directory").keep();
        let blobs = BlobService::new(directory, store.clone(), 1024 * 1024)
            .await
            .expect("blobs");
        (
            store.clone(),
            session.id,
            TurnId::new(),
            MediaService::new(store, blobs),
        )
    }

    fn tool_context(session_id: SessionId, turn_id: TurnId) -> ToolCallContext {
        let (events, _receiver) = event_channel(8);
        ToolCallContext {
            cancellation: CancellationToken::new(),
            events,
            session_id: Some(session_id.to_string()),
            metadata: json!({"turnId":turn_id}),
        }
    }

    async fn wait_for_media(service: &MediaService, kind: &str) -> MediaRequestRecord {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(record) = service
                    .list_pending(Some(kind))
                    .await
                    .expect("pending media")
                    .into_iter()
                    .next()
                {
                    break record;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("media request timeout")
    }

    #[tokio::test]
    async fn question_waits_for_persisted_answer() {
        let store = Store::in_memory().await.expect("store");
        let session = store.create_session("question").await.expect("session");
        let turn_id = TurnId::new();
        let service = QuestionService::new(store.clone());
        let worker = service.clone();
        let task = tokio::spawn(async move {
            let (events, _receiver) = event_channel(8);
            worker
                .execute(
                    &ToolCall {
                        id: "call_1".to_owned(),
                        name: "request_user_input".to_owned(),
                        arguments: json!({
                            "questions": [{
                                "header": "Mode",
                                "question": "Choose mode",
                                "options": [
                                    {"label": "Safe", "description": "Ask first"},
                                    {"label": "Fast", "description": "Proceed"}
                                ]
                            }]
                        }),
                    },
                    ToolCallContext {
                        cancellation: CancellationToken::new(),
                        events,
                        session_id: Some(session.id.to_string()),
                        metadata: json!({"turnId": turn_id}),
                    },
                )
                .await
        });
        let request = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Some(request) = service
                    .list_pending(Some(session.id))
                    .await
                    .expect("pending")
                    .into_iter()
                    .next()
                {
                    break request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("question timeout");
        service
            .resolve(request.id, vec![vec!["Safe".to_owned()]])
            .await
            .expect("answer");
        let output = task.await.expect("join").expect("tool output");
        assert_eq!(
            output.structured_content.expect("structured")["answers"][0][0],
            "Safe"
        );
    }

    #[tokio::test]
    async fn media_arguments_are_rejected_before_a_request_is_persisted() {
        let (_store, session_id, turn_id, service) = media_fixture().await;
        let [_screen, camera] = service.tools();
        let error = camera
            .execute(
                &ToolCall {
                    id: "camera-invalid".to_owned(),
                    name: "capture_camera".to_owned(),
                    arguments: json!({"facingMode":"sideways"}),
                },
                tool_context(session_id, turn_id),
            )
            .await
            .expect_err("invalid facing mode");
        assert_eq!(error.info.code, "invalid_arguments");
        assert!(
            service
                .list_pending(Some("camera"))
                .await
                .expect("pending")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn camera_capture_waits_for_a_valid_image_blob_and_returns_multimodal_content() {
        let (_store, session_id, turn_id, service) = media_fixture().await;
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let blob = service
            .blobs
            .put("image/png", png)
            .await
            .expect("image blob");
        let [_screen, camera] = service.tools();
        let worker = tokio::spawn(async move {
            camera
                .execute(
                    &ToolCall {
                        id: "camera-valid".to_owned(),
                        name: "capture_camera".to_owned(),
                        arguments: json!({"facingMode":"user","prompt":"inspect"}),
                    },
                    tool_context(session_id, turn_id),
                )
                .await
        });
        let request = wait_for_media(&service, "camera").await;
        service
            .resolve(
                request.id,
                Some(json!({
                    "blobId":blob.id,
                    "mime":"image/png",
                    "width":640,
                    "height":480,
                    "facingMode":"user"
                })),
                None,
            )
            .await
            .expect("resolve camera");
        let output = worker.await.expect("worker").expect("camera output");
        assert!(output.success);
        assert!(output.content.iter().any(|content| matches!(
            content,
            ContentBlock::Image { mime_type, .. } if mime_type == "image/png"
        )));
        assert_eq!(output.details["width"], 640);
        assert!(
            service
                .list_pending(Some("camera"))
                .await
                .expect("pending")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn invalid_screen_blob_does_not_consume_the_pending_request() {
        let (store, session_id, turn_id, service) = media_fixture().await;
        let blob = service
            .blobs
            .put("application/octet-stream", b"not an image")
            .await
            .expect("non-image blob");
        let [screen, _camera] = service.tools();
        let worker = tokio::spawn(async move {
            screen
                .execute(
                    &ToolCall {
                        id: "screen-invalid".to_owned(),
                        name: "analyze_screen".to_owned(),
                        arguments: json!({"source":"desktop"}),
                    },
                    tool_context(session_id, turn_id),
                )
                .await
        });
        let request = wait_for_media(&service, "screen").await;
        let error = service
            .resolve(
                request.id,
                Some(json!({
                    "blobId":blob.id,
                    "mime":"application/octet-stream",
                    "width":1920,
                    "height":1080,
                    "source":"desktop"
                })),
                None,
            )
            .await
            .expect_err("non-image media must fail");
        assert!(error.to_string().contains("not a supported raster image"));
        assert_eq!(
            store
                .get_media_request(request.id)
                .await
                .expect("still pending")
                .state,
            "pending"
        );
        service
            .resolve(request.id, None, Some("capture denied".to_owned()))
            .await
            .expect("reject capture");
        let error = worker
            .await
            .expect("worker")
            .expect_err("tool observes rejection");
        assert_eq!(error.info.code, "media_rejected");
    }

    #[tokio::test]
    async fn cancelling_capture_resolves_the_durable_request() {
        let (store, session_id, turn_id, service) = media_fixture().await;
        let [screen, _camera] = service.tools();
        let context = tool_context(session_id, turn_id);
        let cancellation = context.cancellation.clone();
        let worker = tokio::spawn(async move {
            screen
                .execute(
                    &ToolCall {
                        id: "screen-cancel".to_owned(),
                        name: "analyze_screen".to_owned(),
                        arguments: json!({"source":"game"}),
                    },
                    context,
                )
                .await
        });
        let request = wait_for_media(&service, "screen").await;
        cancellation.cancel();
        let error = worker
            .await
            .expect("worker")
            .expect_err("capture cancelled");
        assert_eq!(error.info.code, "aborted");
        let persisted = store
            .get_media_request(request.id)
            .await
            .expect("resolved request");
        assert_eq!(persisted.state, "rejected");
        assert_eq!(persisted.error.as_deref(), Some("media request cancelled"));
    }
}
