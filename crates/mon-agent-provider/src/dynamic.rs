use async_trait::async_trait;
use mon_agent_core::{
    AssistantMessage, ContentBlock, EventEmitter, Message, ModelAdapter, ModelError, ModelOutput,
    ModelRequest, ModelSpec, UserContent, event_channel,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::binding::ResolvedModelBinding;
use crate::config::{OpenAiCompatibleConfig, model_spec_from_env};
use crate::openai::OpenAiCompatibleProvider;
use crate::support::{env_u32, id_text};

#[derive(Clone)]
pub(crate) struct ModelBinding {
    pub(crate) spec: ModelSpec,
    pub(crate) adapter: Option<Arc<dyn ModelAdapter>>,
    pub(crate) info: Value,
    pub(crate) error: Option<String>,
}

/// A process-local provider whose concrete Core-owned configuration can be
/// replaced without restarting the Agent server. API keys remain in this
/// backend object and are never included in `runtime_info`.
#[derive(Clone)]
pub struct DynamicModelProvider {
    default_binding: Arc<RwLock<ModelBinding>>,
    session_bindings: Arc<RwLock<HashMap<String, ModelBinding>>>,
    pub(crate) session_vision_bindings: Arc<RwLock<HashMap<String, ModelBinding>>>,
    actor_bindings: Arc<RwLock<HashMap<(String, String), ModelBinding>>>,
    actor_vision_bindings: Arc<RwLock<HashMap<(String, String), ModelBinding>>>,
}

/// Opaque process-local rollback point used while a durable identity change
/// prepares replacement model adapters. It intentionally contains live
/// adapters and must never be serialized or persisted.
pub struct SessionModelSnapshot {
    session_id: String,
    session_binding: Option<ModelBinding>,
    session_vision_binding: Option<ModelBinding>,
    actor_bindings: Vec<((String, String), ModelBinding)>,
    actor_vision_bindings: Vec<((String, String), ModelBinding)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelAvailability {
    pub default_available: bool,
    pub available_session_bindings: usize,
    pub unavailable_session_bindings: usize,
    pub available_actor_bindings: usize,
    pub unavailable_actor_bindings: usize,
    pub default_error: Option<String>,
}

impl ModelAvailability {
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.default_available
            || self.available_session_bindings > 0
            || self.available_actor_bindings > 0
    }
}

impl DynamicModelProvider {
    #[must_use]
    pub fn from_env() -> Self {
        let spec = model_spec_from_env();
        let (adapter, error) =
            match OpenAiCompatibleConfig::from_env().and_then(OpenAiCompatibleProvider::new) {
                Ok(provider) => (Some(Arc::new(provider) as Arc<dyn ModelAdapter>), None),
                Err(error) => (None, Some(error.to_string())),
            };
        let info = model_runtime_info(
            &spec,
            "env",
            None,
            &spec.id,
            adapter.is_some(),
            error.as_deref(),
        );
        Self {
            default_binding: Arc::new(RwLock::new(ModelBinding {
                spec,
                adapter,
                info,
                error,
            })),
            session_bindings: Arc::new(RwLock::new(HashMap::new())),
            session_vision_bindings: Arc::new(RwLock::new(HashMap::new())),
            actor_bindings: Arc::new(RwLock::new(HashMap::new())),
            actor_vision_bindings: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn model_spec(&self) -> ModelSpec {
        self.default_binding.read().await.spec.clone()
    }

    pub async fn model_spec_for(&self, session_id: Option<&str>) -> ModelSpec {
        self.binding_for(session_id).await.spec
    }

    pub async fn runtime_info(&self) -> Value {
        self.default_binding.read().await.info.clone()
    }

    pub async fn runtime_info_for(&self, session_id: Option<&str>) -> Value {
        self.binding_for(session_id).await.info
    }

    pub async fn error(&self) -> Option<String> {
        self.default_binding.read().await.error.clone()
    }

    pub async fn availability(&self) -> ModelAvailability {
        let (default_available, default_error) = {
            let default = self.default_binding.read().await;
            (default.adapter.is_some(), default.error.clone())
        };
        let sessions = self.session_bindings.read().await;
        let available_session_bindings = sessions
            .values()
            .filter(|binding| binding.adapter.is_some())
            .count();
        let unavailable_session_bindings = sessions
            .values()
            .filter(|binding| binding.adapter.is_none())
            .count();
        drop(sessions);
        let actors = self.actor_bindings.read().await;
        ModelAvailability {
            default_available,
            available_session_bindings,
            unavailable_session_bindings,
            available_actor_bindings: actors
                .values()
                .filter(|binding| binding.adapter.is_some())
                .count(),
            unavailable_actor_bindings: actors
                .values()
                .filter(|binding| binding.adapter.is_none())
                .count(),
            default_error,
        }
    }

    pub async fn clear(&self, reason: impl Into<String>) {
        self.clear_for(None, reason).await;
    }

    pub async fn clear_for(&self, session_id: Option<&str>, reason: impl Into<String>) {
        let reason = reason.into();
        if let Some(session_id) = session_id {
            let existing = self.session_bindings.read().await.get(session_id).cloned();
            let mut binding = match existing {
                Some(binding) => binding,
                None => self.default_binding.read().await.clone(),
            };
            mark_binding_unavailable(&mut binding, &reason);
            self.session_bindings
                .write()
                .await
                .insert(session_id.to_owned(), binding);
        } else {
            let mut binding = self.default_binding.write().await;
            mark_binding_unavailable(&mut binding, &reason);
        }
    }

    pub(crate) async fn configure_resolved_for(
        &self,
        session_id: Option<&str>,
        resolved: ResolvedModelBinding,
    ) -> Result<Value, ModelError> {
        let (binding, info) = model_binding(resolved)?;
        if let Some(session_id) = session_id {
            self.session_bindings
                .write()
                .await
                .insert(session_id.to_owned(), binding);
        } else {
            *self.default_binding.write().await = binding;
        }
        Ok(info)
    }

    pub(crate) async fn configure_resolved_vision_for(
        &self,
        session_id: &str,
        resolved: ResolvedModelBinding,
    ) -> Result<Value, ModelError> {
        let (binding, info) = model_binding(resolved)?;
        if binding
            .spec
            .extra
            .get("is_multimodal")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err(ModelError::new(
                "core_vision_model_invalid",
                "selected vision AI configuration is not multimodal",
            ));
        }
        self.session_vision_bindings
            .write()
            .await
            .insert(session_id.to_owned(), binding);
        Ok(info)
    }

    pub(crate) async fn configure_resolved_for_actor(
        &self,
        session_id: &str,
        assistant_id: &str,
        resolved: ResolvedModelBinding,
    ) -> Result<Value, ModelError> {
        let (binding, info) = model_binding(resolved)?;
        self.actor_bindings
            .write()
            .await
            .insert((session_id.to_owned(), assistant_id.to_owned()), binding);
        Ok(info)
    }

    pub(crate) async fn configure_resolved_vision_for_actor(
        &self,
        session_id: &str,
        assistant_id: &str,
        resolved: ResolvedModelBinding,
    ) -> Result<Value, ModelError> {
        let (binding, info) = model_binding(resolved)?;
        if !model_supports_images(&binding.spec) {
            return Err(ModelError::new(
                "core_vision_model_invalid",
                "selected vision AI configuration is not multimodal",
            ));
        }
        self.actor_vision_bindings
            .write()
            .await
            .insert((session_id.to_owned(), assistant_id.to_owned()), binding);
        Ok(info)
    }

    pub async fn clear_vision_for(&self, session_id: &str) {
        self.session_vision_bindings
            .write()
            .await
            .remove(session_id);
    }

    pub async fn clear_vision_for_actor(&self, session_id: &str, assistant_id: &str) {
        self.actor_vision_bindings
            .write()
            .await
            .remove(&(session_id.to_owned(), assistant_id.to_owned()));
    }

    pub async fn retain_session_actor(&self, session_id: &str, assistant_id: &str) {
        self.actor_bindings
            .write()
            .await
            .retain(|(bound_session, bound_assistant), _| {
                bound_session != session_id || bound_assistant == assistant_id
            });
        self.actor_vision_bindings
            .write()
            .await
            .retain(|(bound_session, bound_assistant), _| {
                bound_session != session_id || bound_assistant == assistant_id
            });
    }

    pub async fn remove_session(&self, session_id: &str) {
        self.session_bindings.write().await.remove(session_id);
        self.session_vision_bindings
            .write()
            .await
            .remove(session_id);
        self.actor_bindings
            .write()
            .await
            .retain(|(bound_session, _), _| bound_session != session_id);
        self.actor_vision_bindings
            .write()
            .await
            .retain(|(bound_session, _), _| bound_session != session_id);
    }

    pub async fn snapshot_session(&self, session_id: &str) -> SessionModelSnapshot {
        SessionModelSnapshot {
            session_id: session_id.to_owned(),
            session_binding: self.session_bindings.read().await.get(session_id).cloned(),
            session_vision_binding: self
                .session_vision_bindings
                .read()
                .await
                .get(session_id)
                .cloned(),
            actor_bindings: self
                .actor_bindings
                .read()
                .await
                .iter()
                .filter(|((bound_session, _), _)| bound_session == session_id)
                .map(|(key, binding)| (key.clone(), binding.clone()))
                .collect(),
            actor_vision_bindings: self
                .actor_vision_bindings
                .read()
                .await
                .iter()
                .filter(|((bound_session, _), _)| bound_session == session_id)
                .map(|(key, binding)| (key.clone(), binding.clone()))
                .collect(),
        }
    }

    pub async fn restore_session(&self, snapshot: SessionModelSnapshot) {
        let session_id = snapshot.session_id;
        let mut session_bindings = self.session_bindings.write().await;
        restore_session_binding(&mut session_bindings, &session_id, snapshot.session_binding);
        drop(session_bindings);
        let mut session_vision_bindings = self.session_vision_bindings.write().await;
        restore_session_binding(
            &mut session_vision_bindings,
            &session_id,
            snapshot.session_vision_binding,
        );
        drop(session_vision_bindings);
        let mut actors = self.actor_bindings.write().await;
        actors.retain(|(bound_session, _), _| bound_session != &session_id);
        actors.extend(snapshot.actor_bindings);
        drop(actors);
        let mut actor_vision = self.actor_vision_bindings.write().await;
        actor_vision.retain(|(bound_session, _), _| bound_session != &session_id);
        actor_vision.extend(snapshot.actor_vision_bindings);
    }

    async fn binding_for(&self, session_id: Option<&str>) -> ModelBinding {
        if let Some(session_id) = session_id {
            if let Some(binding) = self.session_bindings.read().await.get(session_id).cloned() {
                return binding;
            }
        }
        self.default_binding.read().await.clone()
    }

    async fn binding_for_actor(
        &self,
        session_id: Option<&str>,
        assistant_id: Option<&str>,
    ) -> ModelBinding {
        if let (Some(session_id), Some(assistant_id)) = (session_id, assistant_id) {
            if let Some(binding) = self
                .actor_bindings
                .read()
                .await
                .get(&(session_id.to_owned(), assistant_id.to_owned()))
                .cloned()
            {
                return binding;
            }
        }
        self.binding_for(session_id).await
    }
}

fn model_binding(resolved: ResolvedModelBinding) -> Result<(ModelBinding, Value), ModelError> {
    let ResolvedModelBinding {
        spec,
        api_key,
        base_url,
        source,
        entity_id,
        label,
    } = resolved;
    let adapter = OpenAiCompatibleProvider::new(OpenAiCompatibleConfig {
        model: spec.clone(),
        api_key,
        base_url,
        max_retries: env_u32("MON_AGENT_MODEL_MAX_RETRIES", 2).min(5),
        request_timeout: Duration::from_secs(
            env_u32("MON_AGENT_MODEL_TIMEOUT_SECONDS", 90).clamp(5, 300) as u64,
        ),
    })?;
    let info = model_runtime_info(&spec, source, entity_id.as_ref(), &label, true, None);
    let binding = ModelBinding {
        spec,
        adapter: Some(Arc::new(adapter)),
        info: info.clone(),
        error: None,
    };
    Ok((binding, info))
}

fn restore_session_binding(
    bindings: &mut HashMap<String, ModelBinding>,
    session_id: &str,
    binding: Option<ModelBinding>,
) {
    if let Some(binding) = binding {
        bindings.insert(session_id.to_owned(), binding);
    } else {
        bindings.remove(session_id);
    }
}

#[async_trait]
impl ModelAdapter for DynamicModelProvider {
    async fn model_spec_for(&self, session_id: Option<&str>) -> Option<ModelSpec> {
        Some(DynamicModelProvider::model_spec_for(self, session_id).await)
    }

    async fn model_spec_for_actor(
        &self,
        session_id: Option<&str>,
        assistant_id: Option<&str>,
    ) -> Option<ModelSpec> {
        Some(self.binding_for_actor(session_id, assistant_id).await.spec)
    }

    async fn prepare_user_message(
        &self,
        session_id: Option<&str>,
        message: Message,
        cancellation: CancellationToken,
    ) -> Result<Message, ModelError> {
        let Message::User {
            content: UserContent::Blocks(blocks),
            timestamp,
            extra,
        } = message
        else {
            return Ok(message);
        };
        if !blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
        {
            return Ok(Message::User {
                content: UserContent::Blocks(blocks),
                timestamp,
                extra,
            });
        }
        let main = self.binding_for(session_id).await;
        if model_supports_images(&main.spec) {
            return Ok(Message::User {
                content: UserContent::Blocks(blocks),
                timestamp,
                extra,
            });
        }
        let session_id = session_id.ok_or_else(|| {
            ModelError::new(
                "vision_model_unavailable",
                "text-only model received an image without a session-bound vision model",
            )
        })?;
        let vision = self
            .session_vision_bindings
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                ModelError::new(
                    "vision_model_unavailable",
                    "当前对话模型不支持图片，并且没有可用的视觉模型",
                )
            })?;
        let adapter = vision.adapter.clone().ok_or_else(|| {
            ModelError::new(
                "vision_model_unavailable",
                vision
                    .error
                    .clone()
                    .unwrap_or_else(|| "vision model is not configured".to_owned()),
            )
        })?;
        let source_message = Message::User {
            content: UserContent::Blocks(blocks.clone()),
            timestamp,
            extra: extra.clone(),
        };
        let request = ModelRequest {
            model: vision.spec.clone(),
            system_prompt: "你是视觉分析器。完整、客观地描述图片中的界面、文字、状态、异常和与用户请求相关的细节。不要执行工具，不要猜测看不见的内容。".to_owned(),
            messages: vec![source_message],
            tools: Vec::new(),
            session_id: Some(session_id.to_owned()),
            metadata: json!({"purpose":"automatic_vision_fallback"}),
        };
        let (emitter, mut events) = event_channel(256);
        let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });
        let output = adapter.generate(request, emitter, cancellation).await;
        let _ = drain.await;
        let output = output?;
        let analysis = assistant_text(&output.message);
        if analysis.trim().is_empty() {
            return Err(ModelError::new(
                "vision_analysis_empty",
                "vision model returned no textual analysis",
            ));
        }
        let mut prepared = blocks
            .into_iter()
            .filter(|block| !matches!(block, ContentBlock::Image { .. }))
            .collect::<Vec<_>>();
        prepared.push(ContentBlock::Text {
            text: format!(
                "### 自动视觉分析结果\n视觉模型：{}\n{}",
                vision.spec.id,
                analysis.trim()
            ),
        });
        Ok(Message::User {
            content: UserContent::Blocks(prepared),
            timestamp,
            extra,
        })
    }

    async fn generate(
        &self,
        mut request: ModelRequest,
        events: EventEmitter,
        cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        let assistant_id = request
            .metadata
            .get("primaryAssistantId")
            .filter(|value| !value.is_null())
            .map(id_text);
        let binding = self
            .binding_for_actor(request.session_id.as_deref(), assistant_id.as_deref())
            .await;
        let adapter = binding.adapter.ok_or_else(|| {
            ModelError::new(
                "provider_unavailable",
                binding
                    .error
                    .unwrap_or_else(|| "model is not configured".to_owned()),
            )
        })?;
        request.model = binding.spec;
        adapter.generate(request, events, cancellation).await
    }
}

fn model_supports_images(spec: &ModelSpec) -> bool {
    spec.extra
        .get("is_multimodal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn assistant_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn model_runtime_info(
    spec: &ModelSpec,
    source: &str,
    ai_entity_id: Option<&Value>,
    label: &str,
    available: bool,
    error: Option<&str>,
) -> Value {
    json!({
        "id":spec.id,
        "provider":spec.provider,
        "api":spec.api,
        "baseUrl":spec.base_url,
        "contextWindow":spec.context_window,
        "maxTokens":spec.max_tokens,
        "source":source,
        "aiEntityId":ai_entity_id,
        "label":label,
        "available":available,
        "error":error,
    })
}

fn mark_binding_unavailable(binding: &mut ModelBinding, reason: &str) {
    let ai_entity_id = binding.info.get("aiEntityId").cloned();
    let label = binding
        .info
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or(&binding.spec.id)
        .to_owned();
    binding.adapter = None;
    binding.error = Some(reason.to_owned());
    binding.info = model_runtime_info(
        &binding.spec,
        "core",
        ai_entity_id.as_ref(),
        &label,
        false,
        Some(reason),
    );
}
