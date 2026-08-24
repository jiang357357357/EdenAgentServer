use eden_agent_core::{
    AgentEvent, EventEmitter, ModelError, ModelRequest, ModelSpec, estimate_prompt_token_breakdown,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(super) fn validate_request_budget(request: &ModelRequest) -> Result<(), ModelError> {
    let Some(context_window) = request.model.context_window else {
        return Ok(());
    };
    let output_reserve = request
        .model
        .max_tokens
        .unwrap_or_default()
        .min(context_window);
    let prompt_budget = context_window.saturating_sub(output_reserve);
    let estimated = estimate_prompt_token_breakdown(
        &request.system_prompt,
        "",
        "",
        &request.tools,
        &request.messages,
        Some(&request.model.id),
    )
    .total as u64;
    if estimated > prompt_budget {
        return Err(ModelError::new(
            "context_window_exceeded",
            format!(
                "model request requires an estimated {estimated} prompt tokens but only {prompt_budget} are available after reserving {output_reserve} output tokens"
            ),
        ));
    }
    Ok(())
}

pub(super) fn uses_responses_api(model: &ModelSpec) -> bool {
    model.api == "openai-responses"
        || (model.provider.eq_ignore_ascii_case("opencode-go")
            && model.id.eq_ignore_ascii_case("gpt-5.6-luna"))
}

pub(super) fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request() || error.is_body()
}

pub(super) fn retry_delay_ms(attempt: u32) -> u64 {
    500_u64.saturating_mul(1_u64 << (attempt - 1).min(4))
}

pub(super) async fn emit_model_retry(
    events: &EventEmitter,
    attempt: u32,
    max_attempts: u32,
    delay_ms: u64,
    reason: &str,
    status_code: Option<u16>,
) -> Result<(), ModelError> {
    events
        .emit(AgentEvent::ModelRetry {
            attempt,
            max_attempts,
            delay_ms,
            reason: reason.to_owned(),
            status_code,
        })
        .await
        .map_err(|error| ModelError::new("event_sink", error.to_string()))
}

pub(super) async fn wait_retry(
    delay_ms: u64,
    cancellation: &CancellationToken,
) -> Result<(), ModelError> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(ModelError::new("cancelled", "model request cancelled")),
        () = tokio::time::sleep(Duration::from_millis(delay_ms)) => Ok(()),
    }
}
