use eden_agent_core::{ModelError, ModelSpec};
use serde_json::{Map as JsonMap, Value};
use std::{fmt, sync::Arc, time::Duration};

use crate::support::{env_bool, env_u32};

#[derive(Clone)]
pub struct OpenAiCompatibleConfig {
    pub model: ModelSpec,
    pub api_key: Arc<str>,
    pub base_url: String,
    pub max_retries: u32,
    pub request_timeout: Duration,
}

impl fmt::Debug for OpenAiCompatibleConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiCompatibleConfig")
            .field("model", &self.model)
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .field("max_retries", &self.max_retries)
            .field("request_timeout", &self.request_timeout)
            .finish()
    }
}

impl OpenAiCompatibleConfig {
    pub fn from_env() -> Result<Self, ModelError> {
        let model = model_spec_from_env();
        let provider = model.provider.as_str();
        let provider_key = format!(
            "{}_API_KEY",
            provider.to_ascii_uppercase().replace('-', "_")
        );
        let api_key = std::env::var(&provider_key)
            .or_else(|_| std::env::var("OPENAI_API_KEY"))
            .map_err(|_| {
                ModelError::new(
                    "missing_api_key",
                    format!("missing {provider_key} or OPENAI_API_KEY"),
                )
            })?;
        let base_url = std::env::var("EDEN_AGENT_BASE_URL")
            .or_else(|_| std::env::var("OPENAI_BASE_URL"))
            .unwrap_or_else(|_| "https://api.openai.com/v1".to_owned());
        Ok(Self {
            model: ModelSpec {
                base_url: Some(base_url.clone()),
                ..model
            },
            api_key: Arc::from(api_key),
            base_url,
            max_retries: env_u32("EDEN_AGENT_MODEL_MAX_RETRIES", 2).min(5),
            request_timeout: Duration::from_secs(
                env_u32("EDEN_AGENT_MODEL_TIMEOUT_SECONDS", 90).clamp(5, 300) as u64,
            ),
        })
    }
}

#[must_use]
pub fn model_spec_from_env() -> ModelSpec {
    let raw_model =
        std::env::var("EDEN_AGENT_MODEL").unwrap_or_else(|_| "openai/gpt-4o-mini".to_owned());
    let (provider, model_id) = raw_model
        .split_once('/')
        .map_or(("openai", raw_model.as_str()), |(provider, model)| {
            (provider, model)
        });
    let mut extra = JsonMap::new();
    extra.insert(
        "is_multimodal".to_owned(),
        Value::Bool(env_bool("EDEN_AGENT_MODEL_SUPPORTS_IMAGES", true)),
    );
    ModelSpec {
        id: model_id.to_owned(),
        provider: provider.to_owned(),
        api: "openai-completions".to_owned(),
        base_url: std::env::var("EDEN_AGENT_BASE_URL")
            .or_else(|_| std::env::var("OPENAI_BASE_URL"))
            .ok(),
        context_window: Some(env_u32("EDEN_AGENT_CONTEXT_WINDOW", 128_000) as u64),
        max_tokens: Some(env_u32("EDEN_AGENT_MAX_OUTPUT_TOKENS", 16_384) as u64),
        extra,
    }
}
