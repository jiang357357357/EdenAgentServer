use eden_agent_core::{ModelError, ModelSpec};
use serde_json::{Map as JsonMap, Value, json};
use std::sync::Arc;

use crate::binding::ResolvedModelBinding;
use crate::support::id_text;

pub(crate) fn required_text(value: &Value, key: &str) -> Result<String, ModelError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ModelError::new("core_model_invalid", format!("AI entity is missing {key}")))
}

pub(crate) fn integer_param(values: &JsonMap<String, Value>, key: &str) -> Option<u64> {
    values
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

pub(super) fn result_array(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .or_else(|| value.get("results").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

pub(super) fn empty_value(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|value| value.trim().is_empty())
}

pub(super) fn ids_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => id_text(left) == id_text(right),
        _ => false,
    }
}

pub(crate) fn resolve_core_model(
    entity: &Value,
    label: &str,
) -> Result<ResolvedModelBinding, ModelError> {
    let entity_id = entity
        .get("id")
        .cloned()
        .ok_or_else(|| ModelError::new("core_model_invalid", "AI entity has no ID"))?;
    if entity.get("status").and_then(Value::as_str) != Some("active") {
        return Err(ModelError::new(
            "core_model_inactive",
            "selected AI configuration is not active",
        ));
    }
    let model_id = required_text(entity, "ai_model")?;
    let vendor = required_text(entity, "vendor")?;
    let api_key = required_text(entity, "api_key")?;
    let base_url = required_text(entity, "api_endpoint")?;
    let defaults = entity
        .get("default_params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let context_window = integer_param(&defaults, "context_window").unwrap_or(128_000);
    let max_tokens = integer_param(&defaults, "max_tokens").unwrap_or(16_384);
    let mut extra = JsonMap::new();
    for key in [
        "temperature",
        "top_p",
        "reasoning_effort",
        "thinking_enabled",
    ] {
        if let Some(value) = defaults.get(key) {
            extra.insert(key.to_owned(), value.clone());
        }
    }
    extra.insert(
        "is_multimodal".to_owned(),
        Value::Bool(
            entity
                .get("is_multimodal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    let spec = ModelSpec {
        id: model_id,
        provider: vendor,
        api: "openai-completions".to_owned(),
        base_url: Some(base_url.clone()),
        context_window: Some(context_window),
        max_tokens: Some(max_tokens),
        extra,
    };
    Ok(ResolvedModelBinding {
        spec,
        api_key: Arc::from(api_key),
        base_url,
        source: "core",
        entity_id: Some(entity_id),
        label: label.to_owned(),
    })
}

pub(crate) fn model_option(entity: &Value, current_id: Option<&Value>, vendors: &Value) -> Value {
    let id = entity.get("id").cloned().unwrap_or(Value::Null);
    let vendor = entity.get("vendor").and_then(Value::as_str).unwrap_or("");
    let model = entity.get("ai_model").and_then(Value::as_str).unwrap_or("");
    let name = entity.get("ai_name").and_then(Value::as_str).unwrap_or("");
    let context_window = entity
        .get("default_params")
        .and_then(Value::as_object)
        .and_then(|defaults| integer_param(defaults, "context_window"))
        .unwrap_or(128_000);
    let vendor_info = vendors.get(vendor).filter(|value| value.is_object());
    json!({
        "id":id_text(&id),
        "aiEntityId":id,
        "label":if name.trim().is_empty() {model} else {name},
        "name":name,
        "provider":vendor,
        "providerName":vendor_info.and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or(vendor),
        "providerIcon":vendor_info.and_then(|value| value.get("icon")).and_then(Value::as_str).unwrap_or(vendor),
        "supportedModels":vendor_info.and_then(|value| value.get("models")).cloned().unwrap_or_else(|| json!([])),
        "modelID":model,
        "status":entity.get("status").and_then(Value::as_str).unwrap_or(""),
        "isMultimodal":entity.get("is_multimodal").and_then(Value::as_bool).unwrap_or(false),
        "isChoiceDefault":entity.get("is_choice_default").and_then(Value::as_bool).unwrap_or(false),
        "isVisionDefault":entity.get("is_vision_default").and_then(Value::as_bool).unwrap_or(false),
        "contextWindow":context_window,
        "selected":ids_equal(Some(&id), current_id),
    })
}
