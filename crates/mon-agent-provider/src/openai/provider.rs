use async_trait::async_trait;
use mon_agent_core::{
    AgentEvent, EventEmitter, ModelAdapter, ModelError, ModelOutput, ModelRequest, ModelSpec,
};
use reqwest::Client;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::config::OpenAiCompatibleConfig;
use crate::support::{is_retryable_status, truncate};

use super::capabilities::ProviderCapabilities;
use super::contract::validate_request_contract;
use super::payload::{chat_payload, responses_payload};
use super::retry::{
    emit_model_retry, is_retryable_transport_error, retry_delay_ms, uses_responses_api,
    validate_request_budget, wait_retry,
};
use super::speaker::current_speaker_names;
use super::stream::{parse_chat_stream, parse_responses_stream};

#[derive(Clone)]
pub struct OpenAiCompatibleProvider {
    config: OpenAiCompatibleConfig,
    client: Client,
}

impl OpenAiCompatibleProvider {
    pub fn new(config: OpenAiCompatibleConfig) -> Result<Self, ModelError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(config.request_timeout)
            .user_agent(format!("MonAgent/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| ModelError::new("provider_client", error.to_string()))?;
        Ok(Self { config, client })
    }

    #[must_use]
    pub fn model_spec(&self) -> &ModelSpec {
        &self.config.model
    }

    fn endpoint(&self, model: &ModelSpec) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        if uses_responses_api(model) {
            if base.ends_with("/responses") {
                base.to_owned()
            } else {
                format!("{base}/responses")
            }
        } else if base.ends_with("/chat/completions") {
            base.to_owned()
        } else {
            format!("{base}/chat/completions")
        }
    }
}

#[async_trait]
impl ModelAdapter for OpenAiCompatibleProvider {
    async fn generate(
        &self,
        request: ModelRequest,
        events: EventEmitter,
        cancellation: CancellationToken,
    ) -> Result<ModelOutput, ModelError> {
        validate_request_budget(&request)?;
        let capabilities = ProviderCapabilities::for_model(&request.model);
        validate_request_contract(&request)?;
        let responses_api = uses_responses_api(&request.model);
        let payload = if responses_api {
            responses_payload(&request, capabilities)
        } else {
            chat_payload(&request, capabilities)
        };
        let speaker_names = current_speaker_names(&request);
        let max_attempts = self.config.max_retries + 1;
        for attempt in 1..=max_attempts {
            let send = self
                .client
                .post(self.endpoint(&request.model))
                .bearer_auth(self.config.api_key.as_ref())
                .json(&payload)
                .send();
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Err(ModelError::new("cancelled", "model request cancelled")),
                response = send => response,
            };
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    let error = ModelError {
                        code: "provider_transport".to_owned(),
                        message: error.to_string(),
                        retryable: is_retryable_transport_error(&error),
                    };
                    if !error.retryable || attempt == max_attempts {
                        return Err(error);
                    }
                    let delay_ms = retry_delay_ms(attempt);
                    emit_model_retry(
                        &events,
                        attempt + 1,
                        max_attempts,
                        delay_ms,
                        &error.message,
                        None,
                    )
                    .await?;
                    wait_retry(delay_ms, &cancellation).await?;
                    continue;
                }
            };
            let status = response.status();
            if status.is_success() {
                let parsed = if responses_api {
                    parse_responses_stream(
                        &request.model,
                        response,
                        events.clone(),
                        cancellation.clone(),
                        &speaker_names,
                    )
                    .await
                } else {
                    parse_chat_stream(
                        &request.model,
                        response,
                        events.clone(),
                        cancellation.clone(),
                        &speaker_names,
                    )
                    .await
                };
                match parsed {
                    Ok(output) => return Ok(output),
                    Err(failure) => {
                        let can_retry = failure.error.retryable
                            && !failure.tool_calls_started
                            && attempt < max_attempts;
                        if !can_retry {
                            return Err(failure.error);
                        }
                        if let Some(message) = failure.reset_message {
                            events
                                .emit(AgentEvent::StreamReset {
                                    message,
                                    reason: failure.error.message.clone(),
                                })
                                .await
                                .map_err(|error| {
                                    ModelError::new("event_sink", error.to_string())
                                })?;
                        }
                        let delay_ms = retry_delay_ms(attempt);
                        emit_model_retry(
                            &events,
                            attempt + 1,
                            max_attempts,
                            delay_ms,
                            &failure.error.message,
                            None,
                        )
                        .await?;
                        wait_retry(delay_ms, &cancellation).await?;
                        continue;
                    }
                }
            }

            let retryable = is_retryable_status(status);
            let body = response.text().await.unwrap_or_default();
            if !retryable || attempt == max_attempts {
                return Err(ModelError {
                    code: format!("provider_http_{}", status.as_u16()),
                    message: format!("model request failed: {status} {}", truncate(&body, 2_000)),
                    retryable,
                });
            }
            let delay_ms = retry_delay_ms(attempt);
            emit_model_retry(
                &events,
                attempt + 1,
                max_attempts,
                delay_ms,
                &format!("HTTP {}", status.as_u16()),
                Some(status.as_u16()),
            )
            .await?;
            wait_retry(delay_ms, &cancellation).await?;
        }
        Err(ModelError::new(
            "provider_exhausted",
            "model retry loop exhausted",
        ))
    }
}
