use chrono::{DateTime, Utc};
use mon_agent_core::{ToolFailure, ToolOutput};
use serde_json::Value;

pub(crate) trait DefaultString {
    fn or_default_to(self, value: &str) -> String;
}
impl DefaultString for String {
    fn or_default_to(self, value: &str) -> String {
        if self.is_empty() {
            value.to_owned()
        } else {
            self
        }
    }
}
pub(crate) fn string(value: &Value, key: &str) -> Result<String, ToolFailure> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{key} is required")))
}
pub(crate) fn optional_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
pub(crate) fn integer(value: &Value, key: &str) -> Result<i64, ToolFailure> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{key} must be an integer")))
}
pub(crate) fn limit(value: &Value) -> u32 {
    value
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(20)
        .clamp(1, 200) as u32
}
pub(crate) fn timestamp(value: Option<&Value>) -> Result<Option<i64>, ToolFailure> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => Ok(value.as_i64()),
        Some(Value::String(value)) => DateTime::parse_from_rfc3339(value)
            .map(|value| Some(value.timestamp_millis()))
            .map_err(|error| ToolFailure::new("invalid_datetime", error.to_string())),
        _ => Err(ToolFailure::new(
            "invalid_datetime",
            "expected RFC3339 string or milliseconds",
        )),
    }
}
pub(crate) fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}
pub(crate) fn output(value: Value) -> ToolOutput {
    let mut result = ToolOutput::text(serde_json::to_string_pretty(&value).unwrap_or_default());
    result.details = value.clone();
    result.structured_content = Some(value);
    result
}

pub(crate) fn structured_output(text: impl Into<String>, value: Value) -> ToolOutput {
    let mut result = ToolOutput::text(text);
    result.details = value.clone();
    result.structured_content = Some(value);
    result
}

pub(crate) fn store_failure(error: mon_agent_store::StoreError) -> ToolFailure {
    ToolFailure::new("store_failed", error.to_string())
}
