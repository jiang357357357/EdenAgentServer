use mon_agent_core::{ModelError, ModelRequest, validate_tool_definitions};

pub(super) fn validate_request_contract(request: &ModelRequest) -> Result<(), ModelError> {
    validate_tool_definitions(&request.tools).map_err(|error| ModelError {
        code: "invalid_tool_schema".to_owned(),
        message: format!("model request contains a non-portable function-tool schema: {error}"),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mon_agent_core::{ModelSpec, ToolDefinition};
    use serde_json::json;

    fn request_with(tool: ToolDefinition) -> ModelRequest {
        let model = ModelSpec {
            provider: "deepseek".to_owned(),
            ..ModelSpec::default()
        };
        ModelRequest {
            model: model.clone(),
            system_prompt: String::new(),
            messages: Vec::new(),
            tools: vec![tool],
            session_id: None,
            metadata: json!({}),
        }
    }

    #[test]
    fn invalid_tool_schemas_fail_locally_before_a_provider_request() {
        let mut tool = ToolDefinition::direct("broken", "broken schema");
        tool.parameters = json!({});
        let request = request_with(tool);
        let error = validate_request_contract(&request).expect_err("empty schema must fail");
        assert_eq!(error.code, "invalid_tool_schema");
        assert!(error.message.contains("broken"));
    }
}
