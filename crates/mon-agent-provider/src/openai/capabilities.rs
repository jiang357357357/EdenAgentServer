use mon_agent_core::ModelSpec;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderFamily {
    OpenAi,
    DeepSeek,
    OpenCodeGo,
    GenericOpenAiCompatible,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ProviderCapabilities {
    pub(super) family: ProviderFamily,
    pub(super) prompt_cache_key: bool,
    pub(super) reasoning_effort: bool,
    pub(super) stream_usage: bool,
}

impl ProviderCapabilities {
    pub(super) fn for_model(model: &ModelSpec) -> Self {
        let provider = model.provider.trim().to_ascii_lowercase().replace('_', "-");
        let mut capabilities = match provider.as_str() {
            "openai" => Self {
                family: ProviderFamily::OpenAi,
                prompt_cache_key: true,
                reasoning_effort: true,
                stream_usage: true,
            },
            "deepseek" => Self {
                family: ProviderFamily::DeepSeek,
                prompt_cache_key: false,
                reasoning_effort: false,
                stream_usage: true,
            },
            "opencode-go" => Self {
                family: ProviderFamily::OpenCodeGo,
                prompt_cache_key: true,
                reasoning_effort: true,
                stream_usage: true,
            },
            _ => Self {
                family: ProviderFamily::GenericOpenAiCompatible,
                prompt_cache_key: false,
                reasoning_effort: false,
                stream_usage: true,
            },
        };
        capabilities.prompt_cache_key = bool_override(
            model,
            &["supportsPromptCacheKey", "supports_prompt_cache_key"],
            capabilities.prompt_cache_key,
        );
        capabilities.reasoning_effort = bool_override(
            model,
            &["supportsReasoningEffort", "supports_reasoning_effort"],
            capabilities.reasoning_effort,
        );
        capabilities.stream_usage = bool_override(
            model,
            &["supportsStreamUsage", "supports_stream_usage"],
            capabilities.stream_usage,
        );
        capabilities
    }
}

fn bool_override(model: &ModelSpec, keys: &[&str], fallback: bool) -> bool {
    keys.iter()
        .find_map(|key| model.extra.get(*key).and_then(serde_json::Value::as_bool))
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_names_are_normalized_and_capabilities_can_be_overridden() {
        let mut model = ModelSpec {
            provider: "opencode_go".to_owned(),
            ..ModelSpec::default()
        };
        let capabilities = ProviderCapabilities::for_model(&model);
        assert_eq!(capabilities.family, ProviderFamily::OpenCodeGo);
        assert!(capabilities.prompt_cache_key);
        assert!(capabilities.reasoning_effort);

        model.provider = "deepseek".to_owned();
        model
            .extra
            .insert("supportsReasoningEffort".to_owned(), json!(true));
        let capabilities = ProviderCapabilities::for_model(&model);
        assert_eq!(capabilities.family, ProviderFamily::DeepSeek);
        assert!(capabilities.reasoning_effort);
        assert!(!capabilities.prompt_cache_key);
    }
}
