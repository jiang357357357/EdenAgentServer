use crate::{
    HostServices,
    support::{output, store_failure, timestamp},
};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use mon_agent_core::{
    PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput,
};
use mon_agent_domain::SessionId;
use serde_json::{Value, json};
use std::sync::Arc;

struct SelfAwakeTool(HostServices);
#[async_trait]
impl Tool for SelfAwakeTool {
    fn definition(&self) -> ToolDefinition {
        let mut value = ToolDefinition::direct(
            "set_self_awake_timer",
            "Schedule a durable future agent activation",
        );
        value.parameters = json!({"type":"object","properties":{"afterMinutes":{"type":"integer","minimum":1,"maximum":10080},"at":{"type":["string","integer"]},"reason":{"type":"string"}}});
        value
    }
    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        Some(PermissionRequest {
            permission: "job.schedule".to_owned(),
            patterns: vec![arguments.to_string()],
            always: vec![],
        })
    }
    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let session = context
            .session_id
            .as_deref()
            .ok_or_else(|| {
                ToolFailure::new("missing_session", "self-awake timer requires a session")
            })?
            .parse::<SessionId>()
            .map_err(|error| ToolFailure::new("invalid_session", error.to_string()))?;
        let due_at = timestamp(call.arguments.get("at"))?
            .or_else(|| {
                call.arguments
                    .get("afterMinutes")
                    .and_then(Value::as_i64)
                    .map(|minutes| {
                        (Utc::now() + Duration::minutes(minutes.clamp(1, 10080))).timestamp_millis()
                    })
            })
            .ok_or_else(|| ToolFailure::new("invalid_timer", "at or afterMinutes is required"))?;
        let reason = call
            .arguments
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Scheduled self-awake activation");
        let operation_id = context
            .metadata
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(&call.id);
        let key = format!("self-awake:{session}:{operation_id}");
        let job = self
            .0
            .store
            .schedule_job(
                "self_awake",
                Some(session),
                due_at,
                json!({
                    "prompt":reason,
                    "trigger":{
                        "type":"scheduled",
                        "reason":reason,
                        "requestedBy":"agent",
                        "operationId":operation_id,
                    }
                }),
                &key,
            )
            .await
            .map_err(store_failure)?;
        Ok(output(serde_json::to_value(job).unwrap_or_default()))
    }
}

pub(super) fn tool(host: HostServices) -> Arc<dyn Tool> {
    Arc::new(SelfAwakeTool(host))
}
