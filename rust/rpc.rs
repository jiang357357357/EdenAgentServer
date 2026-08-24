use super::*;

#[derive(Debug)]
pub(crate) struct RpcFailure {
    pub(crate) code: i32,
    pub(crate) message: String,
}

impl RpcFailure {
    pub(crate) fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }

    pub(crate) fn application(message: impl Into<String>) -> Self {
        Self {
            code: -32010,
            message: message.into(),
        }
    }
}

#[cfg(test)]
pub(crate) async fn execute_method(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    execute_method_for_origin(state, RuntimeOrigin::Mon, method, params).await
}

pub(crate) async fn execute_method_for_origin(
    state: &AppState,
    runtime_origin: RuntimeOrigin,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    enforce_request_origin(state, runtime_origin, method, &params).await?;
    if method == "ping" {
        return Ok(json!({"pong": true}));
    }
    match method.split_once('.').map(|(domain, _)| domain) {
        Some("voice") => execute_voice_rpc(state, runtime_origin, method, params).await,
        Some("session" | "turn" | "event" | "message" | "director") => {
            execute_conversation_rpc(state, runtime_origin, method, params).await
        }
        Some("permission" | "operation" | "question" | "media") => {
            execute_interaction_rpc(state, runtime_origin, method, params).await
        }
        Some("skill" | "plugin") => execute_extensions_rpc(state, method, params).await,
        Some("agent" | "memo" | "connector" | "workspace" | "tool" | "model" | "self_awake") => {
            execute_runtime_rpc(state, runtime_origin, method, params).await
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}
