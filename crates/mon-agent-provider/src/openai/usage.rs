use serde_json::{Value, json};

pub(super) fn normalized_openai_usage(raw: &Value) -> Value {
    let number = |snake: &str, camel: &str| {
        raw.get(snake)
            .or_else(|| raw.get(camel))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };
    let prompt_tokens = number("prompt_tokens", "inputTokens");
    let completion_tokens = number("completion_tokens", "outputTokens");
    let cached_tokens = raw
        .pointer("/prompt_tokens_details/cached_tokens")
        .or_else(|| raw.pointer("/input_tokens_details/cached_tokens"))
        .or_else(|| raw.get("cached_tokens"))
        .or_else(|| raw.get("cacheRead"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cache_is_included = cached_tokens <= prompt_tokens;
    let input_tokens = if cache_is_included {
        prompt_tokens
    } else {
        prompt_tokens.saturating_add(cached_tokens)
    };
    let cache_miss = if cache_is_included {
        prompt_tokens.saturating_sub(cached_tokens)
    } else {
        prompt_tokens
    };
    let total_tokens = number("total_tokens", "totalTokens");
    json!({
        "input":input_tokens,
        "output":completion_tokens,
        "cacheRead":cached_tokens,
        "cacheMiss":cache_miss,
        "cacheWrite":0,
        "totalTokens":if total_tokens == 0 { input_tokens.saturating_add(completion_tokens) } else { total_tokens },
        "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0},
    })
}

pub(super) fn normalized_responses_usage(raw: &Value) -> Value {
    normalized_openai_usage(&json!({
        "prompt_tokens":raw.get("input_tokens").and_then(Value::as_u64).unwrap_or_default(),
        "completion_tokens":raw.get("output_tokens").and_then(Value::as_u64).unwrap_or_default(),
        "prompt_tokens_details":{
            "cached_tokens":raw.pointer("/input_tokens_details/cached_tokens").and_then(Value::as_u64).unwrap_or_default(),
        },
    }))
}
